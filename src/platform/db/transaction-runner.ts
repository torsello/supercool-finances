import { setTimeout as delay } from 'node:timers/promises';
import {
  CLIENT_SIDE_LIMIT_MS,
  RequestTimeout,
  type RequestDeadline,
  type RunScope,
} from '../http/request-timeout.js';
import { AccountLockTimeout, IdempotencyWaitTimeout, RetriesExhausted } from './errors.js';
import {
  classifyDatabaseError,
  isProxyBorrowTimeout,
  isRetryable,
  sqlstateOf,
} from './sqlstate.js';

/** Attempts in total for a money movement, the first included (SYS-R18). */
export const MAX_ATTEMPTS = 3;

/** Upper bound, in ms, of the random wait before retry `retry` (1-based): min(200, 10 × 2^(n−1)). */
export function backoffBound(retry: number): number {
  return Math.min(200, 10 * 2 ** (retry - 1));
}

/** The part of a pooled `pg` client the runner uses; `pg.PoolClient` fits it. */
export interface RunnerClient {
  query(text: string): Promise<{ command: string }>;
  /** `'I'` idle, `'T'` in a transaction, `'E'` in a failed transaction, `null` unknown. */
  getTransactionStatus(): string | null;
  /** With an error, the pool destroys the client instead of handing it to another request. */
  release(error?: Error): void;
  /** A lost connection emits `'error'`, which ends the process when nothing listens. */
  on(event: 'error', listener: (error: Error) => void): unknown;
  off(event: 'error', listener: (error: Error) => void): unknown;
}

export interface RunnerPool<Client extends RunnerClient> {
  connect(): Promise<Client>;
}

/** `movement` retries 40P01 and 40001 (SYS-R18); `none` never retries (plan 000 section 6.1). */
export type RetryPolicy = 'movement' | 'none';

/** What the runner reports for the metrics of section 1.4 of spec 007. */
export interface TransactionObserver {
  /** An attempt failed with 40P01 or 40001 and is retried. */
  retried(sqlstate: '40P01' | '40001'): void;
  /** The last attempt failed with 40P01 or 40001 (SYS-R19). */
  retriesExhausted(): void;
  /** A lock wait ended with 55P03: at an account row lock, or at the key wait. */
  lockTimeout(lock: 'account' | 'idempotency'): void;
}

export interface TransactionRunnerOptions<Client extends RunnerClient> {
  pool: RunnerPool<Client>;
  observer?: TransactionObserver;
  /** A number in [0, 1), `Math.random` by default. */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * The request a run serves, when none is given to `run`: in the service, the context of the
   * request whose code is running (`request-timeout.ts`); none outside a request.
   */
  scope?: () => RunScope | undefined;
}

export interface RunOptions {
  retry: RetryPolicy;
  /** The request the run serves, with its deadline; the runner's own `scope` otherwise. */
  scope?: RunScope;
}

const BEGIN = 'BEGIN ISOLATION LEVEL READ COMMITTED';

/** Marks the deadline winning the race against a run. */
const TIMED_OUT = Symbol('timed out');

/**
 * The client a unit of work gets when the run has a deadline: every statement checks it first, so
 * no statement starts after the deadline (SEC-R33). Every other member is the client's own.
 */
function guarded<Client extends RunnerClient>(client: Client, deadline: RequestDeadline): Client {
  // The unit of work calls `query(text, values)`, which `RunnerClient` does not declare.
  const callable = client as unknown as { query(...args: unknown[]): unknown };
  const query = (...args: unknown[]): unknown => {
    if (deadline.passed) throw new RequestTimeout();
    return callable.query(...args);
  };
  return new Proxy(client, {
    get(target, property) {
      if (property === 'query') return query;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function'
        ? ((value as (...args: unknown[]) => unknown).bind(target) as unknown)
        : value;
    },
  });
}

/**
 * Runs a unit of work in one database transaction (plan 000 section 6.1). One pool connection
 * serves every attempt, so the pool's acquire timeout is waited at most once. A client whose
 * state the runner cannot account for is released with an error, so the pool destroys it.
 *
 * A run for a request has its deadline (SEC-R33, ADR-0022). At the deadline the run ends at once
 * with `RequestTimeout`, answered 503, while its clean-up goes on: no statement starts after the
 * deadline, `BEGIN` of another attempt included; the statement in flight is awaited whatever its
 * outcome, and the transaction is then rolled back; a `COMMIT` already sent finishes; a connection
 * acquired after the deadline is released unused; and a statement that sends no reply within
 * `CLIENT_SIDE_LIMIT_MS` of the deadline has its connection destroyed. Nothing is ever sent on
 * another connection to cancel a statement. The connection is held in the request's scope until it
 * is released, so the shutdown waits for the clean-up (SEC-R27).
 */
export class TransactionRunner<Client extends RunnerClient> {
  readonly #pool: RunnerPool<Client>;
  readonly #observer: TransactionObserver | undefined;
  readonly #random: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  readonly #scope: (() => RunScope | undefined) | undefined;

  constructor(options: TransactionRunnerOptions<Client>) {
    this.#pool = options.pool;
    this.#observer = options.observer;
    this.#random = options.random ?? Math.random;
    this.#sleep = options.sleep ?? ((ms) => delay(ms));
    this.#scope = options.scope;
  }

  async run<T>(work: (client: Client) => Promise<T>, options: RunOptions): Promise<T> {
    const scope = options.scope ?? this.#scope?.();
    if (scope === undefined) {
      return await this.#lifecycle(work, options.retry, undefined, { transactionStarted: false });
    }
    const { deadline } = scope;
    if (deadline.passed) throw new RequestTimeout({ transactionStarted: false });
    const progress = { transactionStarted: false };
    const outcome = await Promise.race([
      this.#lifecycle(work, options.retry, scope, progress).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      ),
      deadline.whenPassed.then((): typeof TIMED_OUT => TIMED_OUT),
    ]);
    if (outcome === TIMED_OUT) {
      throw new RequestTimeout({ transactionStarted: progress.transactionStarted });
    }
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  }

  /**
   * The whole run on one connection: acquire, attempts, clean-up and release. `progress` records
   * when the first `BEGIN` is sent.
   */
  async #lifecycle<T>(
    work: (client: Client) => Promise<T>,
    retry: RetryPolicy,
    scope: RunScope | undefined,
    progress: { transactionStarted: boolean },
  ): Promise<T> {
    const client = await this.#pool.connect();
    const deadline = scope?.deadline;
    if (deadline?.passed === true) {
      // Acquired after the deadline: released unused, no BEGIN.
      client.release();
      throw new RequestTimeout();
    }
    const connection: { broken?: Error } = {};
    // pg-pool listens only on idle clients: while this run holds the client, a lost connection is
    // recorded here, so the client is destroyed on release and the process keeps running.
    const onError = (error: Error) => {
      connection.broken ??= error;
    };
    client.on('error', onError);
    let released = false;
    let limit: unknown;
    let unhold: () => void = () => undefined;
    // Once only: the client-side limit or the shutdown may release it before the run ends.
    const release = (error?: Error) => {
      if (released) return;
      released = true;
      if (limit !== undefined) deadline?.timers.clearTimeout(limit);
      client.off('error', onError);
      client.release(error);
      unhold();
    };
    if (scope !== undefined && deadline !== undefined) {
      unhold = scope.hold({
        destroy: () => {
          release(new Error('connection destroyed at the shutdown deadline'));
        },
      });
      void deadline.whenPassed.then(() => {
        if (released) return;
        limit = deadline.timers.setTimeout(() => {
          release(new Error('the statement in flight sent no reply within the client-side limit'));
        }, CLIENT_SIDE_LIMIT_MS);
      });
    }
    try {
      return await this.#attempts(client, connection, work, retry, deadline, progress);
    } finally {
      release(connection.broken);
    }
  }

  async #attempts<T>(
    client: Client,
    connection: { broken?: Error },
    work: (client: Client) => Promise<T>,
    retry: RetryPolicy,
    deadline: RequestDeadline | undefined,
    progress: { transactionStarted: boolean },
  ): Promise<T> {
    const workClient = deadline === undefined ? client : guarded(client, deadline);
    // A call, not a property read, so it is read afresh after every await.
    const timeUp = (): boolean => deadline?.passed === true;
    for (let attempt = 1; ; attempt += 1) {
      // No transaction is open here: past the deadline nothing starts, and nothing is rolled back.
      if (timeUp()) throw new RequestTimeout();
      try {
        progress.transactionStarted = true;
        await client.query(BEGIN);
        const result = await work(workClient);
        // COMMIT is a further statement too: past the deadline the transaction is rolled back.
        if (timeUp()) throw new RequestTimeout();
        const commit = await client.query('COMMIT');
        // PostgreSQL answers COMMIT of a failed transaction with ROLLBACK, and no error.
        if (commit.command !== 'COMMIT') throw new Error('COMMIT did not commit the transaction');
        connection.broken ??= unaccounted(client);
        return result;
      } catch (error) {
        // After RDS Proxy's borrow timeout nothing more is sent, not even ROLLBACK, which would
        // wait for a connection again: the client is destroyed on release (SEC-R49).
        connection.broken ??= isProxyBorrowTimeout(error)
          ? new Error('the database proxy found no connection in time', { cause: error })
          : await rollBack(client);
        if (retry === 'movement' && isRetryable(error)) {
          // A broken connection cannot serve another attempt, so this one was the last (SYS-R19).
          if (connection.broken !== undefined || attempt >= MAX_ATTEMPTS) {
            this.#observer?.retriesExhausted();
            throw new RetriesExhausted(attempt, { cause: error });
          }
          if (timeUp()) throw new RequestTimeout();
          this.#observer?.retried(sqlstateOf(error) === '40P01' ? '40P01' : '40001');
          await this.#sleep(this.#random() * backoffBound(attempt));
          continue;
        }
        const classified = classifyDatabaseError(error, 'work');
        // Only a lock wait that ended with 55P03 counts (table 1.4 of spec 007): a key wait whose
        // deadline ran out before another wait is an IdempotencyWaitTimeout without that cause.
        if (sqlstateOf(classified) === '55P03') {
          if (classified instanceof AccountLockTimeout) this.#observer?.lockTimeout('account');
          if (classified instanceof IdempotencyWaitTimeout) {
            this.#observer?.lockTimeout('idempotency');
          }
        }
        throw classified;
      }
    }
  }
}

/** Rolls back; returns the reason the client cannot go back to the pool, if there is one. */
async function rollBack(client: RunnerClient): Promise<Error | undefined> {
  try {
    await client.query('ROLLBACK');
  } catch (error) {
    return new Error('ROLLBACK failed', { cause: error });
  }
  return unaccounted(client);
}

/** An error when the client is not idle outside a transaction, as it must be between attempts. */
function unaccounted(client: RunnerClient): Error | undefined {
  const status = client.getTransactionStatus();
  return status === 'I' ? undefined : new Error(`connection left in state ${String(status)}`);
}
