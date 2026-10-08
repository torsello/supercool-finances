import { createServer, type Server } from 'node:http';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';
import type { FastifyInstance } from 'fastify';

/** The kinds of a money movement (section 1.4 of spec 007). */
export type MovementKind = 'deposit' | 'withdrawal' | 'transfer' | 'reversal';

/** What a keyed request's answer counts as: a movement's outcome, or a replay. */
export type KeyedOutcome = 'applied' | 'rejected' | 'failed' | 'replayed';

/** The kinds a replay is counted under: the movements and account creation. */
export type KeyedKind = MovementKind | 'account_creation';

/** A lock wait that ended with SQLSTATE 55P03. */
export type LockKind = 'account' | 'idempotency';

/** The SQLSTATEs the transaction runner retries (SYS-R18). */
export type RetriedSqlstate = '40P01' | '40001';

/** The part of a `pg` pool the gauge reads. */
export interface PoolStatistics {
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
}

/** The route label of a request that matched no route (SEC-R42). */
export const UNMATCHED_ROUTE = 'unmatched';

/** The path the metrics server answers on; every other path is 404. */
const METRICS_PATH = '/metrics';

/**
 * The metrics of table 1.4 of spec 007, with the default Node.js process metrics, in a registry of
 * this app's own, so two apps in one process never share a count. Every label has a fixed set of
 * values (SEC-R42).
 */
export class Metrics {
  readonly registry = new Registry();
  readonly #requestDuration: Histogram<'method' | 'route' | 'status_code'>;
  readonly #movements: Counter<'kind' | 'outcome'>;
  readonly #replays: Counter<'kind'>;
  readonly #lockTimeouts: Counter<'lock'>;
  readonly #retries: Counter<'sqlstate'>;
  readonly #retriesExhausted: Counter;
  readonly #poolAcquireTimeouts: Counter;
  readonly #rateLimited: Counter;
  readonly #rateLimitStoreErrors: Counter;

  constructor(options: { pool: PoolStatistics }) {
    const registers = [this.registry];
    collectDefaultMetrics({ register: this.registry });
    this.#requestDuration = new Histogram({
      name: 'scf_http_request_duration_seconds',
      help: 'Time from receiving a request to sending its response.',
      labelNames: ['method', 'route', 'status_code'],
      registers,
    });
    this.#movements = new Counter({
      name: 'scf_money_movements_total',
      help: 'Movements that reached the idempotency step: 201, a stored 4xx, or a 5xx. Replays are not counted here.',
      labelNames: ['kind', 'outcome'],
      registers,
    });
    this.#replays = new Counter({
      name: 'scf_idempotent_replays_total',
      help: 'Responses answered from a stored key row.',
      labelNames: ['kind'],
      registers,
    });
    this.#lockTimeouts = new Counter({
      name: 'scf_lock_timeouts_total',
      help: 'SQLSTATE 55P03 at an account row lock (503) or at the key insert (409).',
      labelNames: ['lock'],
      registers,
    });
    this.#retries = new Counter({
      name: 'scf_transaction_retries_total',
      help: 'Attempts retried after a deadlock or a serialization failure.',
      labelNames: ['sqlstate'],
      registers,
    });
    this.#retriesExhausted = new Counter({
      name: 'scf_transaction_retries_exhausted_total',
      help: 'Requests that ended with 503 after the last attempt.',
      registers,
    });
    new Gauge({
      name: 'scf_db_pool_connections',
      help: 'Connections of the request pool, and requests waiting for one.',
      labelNames: ['state'],
      registers,
      collect() {
        this.set({ state: 'total' }, options.pool.totalCount);
        this.set({ state: 'idle' }, options.pool.idleCount);
        this.set({ state: 'waiting' }, options.pool.waitingCount);
      },
    });
    this.#poolAcquireTimeouts = new Counter({
      name: 'scf_db_pool_acquire_timeouts_total',
      help: 'Requests answered 503 because no connection was free in time.',
      registers,
    });
    this.#rateLimited = new Counter({
      name: 'scf_rate_limited_total',
      help: 'Requests answered 429 by the per-user limit.',
      registers,
    });
    this.#rateLimitStoreErrors = new Counter({
      name: 'scf_rate_limit_store_errors_total',
      help: 'Per-user limit checks that failed open because Redis did not answer.',
      registers,
    });
  }

  request(method: string, route: string, statusCode: number, seconds: number): void {
    this.#requestDuration.observe({ method, route, status_code: String(statusCode) }, seconds);
  }

  /** A keyed request answered: a movement's outcome, or a replay of any keyed kind. */
  keyed(kind: KeyedKind, outcome: KeyedOutcome): void {
    if (outcome === 'replayed') {
      this.#replays.inc({ kind });
    } else if (kind !== 'account_creation') {
      this.#movements.inc({ kind, outcome });
    }
  }

  lockTimeout(lock: LockKind): void {
    this.#lockTimeouts.inc({ lock });
  }

  retried(sqlstate: RetriedSqlstate): void {
    this.#retries.inc({ sqlstate });
  }

  retriesExhausted(): void {
    this.#retriesExhausted.inc();
  }

  poolAcquireTimeout(): void {
    this.#poolAcquireTimeouts.inc();
  }

  rateLimited(): void {
    this.#rateLimited.inc();
  }

  storeError(): void {
    this.#rateLimitStoreErrors.inc();
  }

  /** The registry in the Prometheus text format, and its content type. */
  async exposition(): Promise<{ contentType: string; body: string }> {
    return { contentType: this.registry.contentType, body: await this.registry.metrics() };
  }
}

/**
 * Observes every response of `app` in `scf_http_request_duration_seconds`, labelled with the route
 * template, such as `/v1/accounts/:id`, never the path as received, and `unmatched` for a path
 * that is not a route, so no id becomes a label value (SEC-R42).
 */
export function registerRequestMetrics(app: FastifyInstance, metrics: Metrics): void {
  app.addHook('onResponse', (request, reply, done) => {
    const route = request.is404 ? UNMATCHED_ROUTE : (request.routeOptions.url ?? UNMATCHED_ROUTE);
    metrics.request(request.method, route, reply.statusCode, reply.elapsedTime / 1000);
    done();
  });
}

/**
 * The second HTTP server, on `METRICS_PORT` only (SEC-R41, SEC-R43): `GET /metrics` answers the
 * registry in the Prometheus text format; every other request answers 404.
 */
export class MetricsServer {
  readonly #server: Server;

  constructor(metrics: Metrics) {
    this.#server = createServer((request, response) => {
      if (request.method !== 'GET' || request.url?.split('?')[0] !== METRICS_PATH) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not Found');
        return;
      }
      metrics.exposition().then(
        ({ contentType, body }) => {
          response.writeHead(200, { 'content-type': contentType }).end(body);
        },
        () => {
          response.writeHead(500).end();
        },
      );
    });
  }

  async listen(port: number, host: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(port, host, () => {
        this.#server.off('error', reject);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (!this.#server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
      this.#server.closeAllConnections();
    });
  }
}
