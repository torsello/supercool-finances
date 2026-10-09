import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { z } from 'zod';
import { problemResponse, sendProblem, toProblem } from '../http/error-handler.js';
import { NotReady } from '../http/errors.js';

/** How long the readiness check may take in total, connection included (SEC-R24). */
export const READINESS_TIMEOUT_MS = 1000;

/** The check that failed, named in the log line only (SEC-R24). */
export type FailedCheck = 'database' | 'migrations';

export interface ReadinessLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

/** The part of a `pg` client readiness uses; `pg.Client` fits it. */
export interface ReadinessClient {
  connect(): Promise<unknown>;
  query(text: string): Promise<{ rows: unknown[] }>;
  end(): Promise<unknown>;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface ReadinessOptions {
  databaseUrl: string;
  /** The names of the migrations the code ships (`migrations-dir.ts`). */
  migrations: readonly string[];
  logger: ReadinessLogger;
  timeoutMs?: number;
  /** Opens a readiness connection; a `pg.Client` by default. */
  client?: (connectionString: string, connectionTimeoutMillis: number) => ReadinessClient;
}

function pgClient(connectionString: string, connectionTimeoutMillis: number): ReadinessClient {
  return new pg.Client({ connectionString, connectionTimeoutMillis });
}

class CheckTimedOut extends Error {
  override readonly name = 'CheckTimedOut';
}

/**
 * The readiness of this replica (SEC-R24, SEC-R26): `SELECT 1` and the migrations check run on a
 * connection of its own, outside the request pool, so a busy pool never marks a healthy replica
 * unready, and the request pool counts it apart (SEC-R36). The whole check, connection included,
 * must finish within `timeoutMs`; a connection that failed or timed out is dropped and opened
 * again by the next check. Every shipped migration must be in `pgmigrations`; migrations the
 * database holds beyond them are accepted, so a replica of the previous version stays ready while
 * a newer one rolls out. Once `stop` is called, for the shutdown, it is never ready again.
 */
export class Readiness {
  readonly #options: ReadinessOptions;
  readonly #timeoutMs: number;
  readonly #open: (connectionString: string, connectionTimeoutMillis: number) => ReadinessClient;
  #client: Promise<ReadinessClient> | undefined;
  #stopped = false;

  constructor(options: ReadinessOptions) {
    this.#options = options;
    this.#timeoutMs = options.timeoutMs ?? READINESS_TIMEOUT_MS;
    this.#open = options.client ?? pgClient;
  }

  /** From now on readiness answers 503 (SEC-R26). */
  stop(): void {
    this.#stopped = true;
  }

  /** Whether the replica is ready; a failed check is logged at `warn` with its name. */
  async ready(): Promise<boolean> {
    if (this.#stopped) return false;
    const failed = await this.#check();
    if (failed === undefined) return true;
    this.#options.logger.warn({ check: failed }, 'not ready');
    return false;
  }

  /** Closes the readiness connection, for the shutdown (SEC-R27, SEC-R28). */
  async close(): Promise<void> {
    this.#stopped = true;
    const client = this.#client;
    this.#client = undefined;
    if (client === undefined) return;
    await client.then(
      async (connected) => {
        await connected.end();
      },
      () => undefined,
    );
  }

  /**
   * One check, on the connection it takes at its start; a failure drops that connection only,
   * never one another check has opened since.
   */
  async #check(): Promise<FailedCheck | undefined> {
    const connection = this.#connection();
    // Set from inside the check, so it is read after the race through an object.
    const progress: { step: FailedCheck } = { step: 'database' };
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new CheckTimedOut('readiness check timed out'));
      }, this.#timeoutMs);
    });
    try {
      await Promise.race([
        (async () => {
          const client = await connection;
          await client.query('SELECT 1');
          progress.step = 'migrations';
          const applied = await client.query('SELECT name FROM pgmigrations');
          const names = new Set((applied.rows as { name: string }[]).map((row) => row.name));
          if (!this.#options.migrations.every((name) => names.has(name))) {
            throw new NotReady();
          }
        })(),
        timedOut,
      ]);
      return undefined;
    } catch (error) {
      // Only an answer of the database about pgmigrations is a migrations failure; a timeout or a
      // lost connection at that step is the database's.
      const migrationsFailure =
        progress.step === 'migrations' &&
        (error instanceof NotReady || error instanceof pg.DatabaseError);
      if (!migrationsFailure) this.#drop(connection);
      return migrationsFailure ? 'migrations' : 'database';
    } finally {
      clearTimeout(timer);
    }
  }

  /** The readiness connection, opened on first use or after it was dropped. */
  #connection(): Promise<ReadinessClient> {
    if (this.#client !== undefined) return this.#client;
    const client = this.#open(this.#options.databaseUrl, this.#timeoutMs);
    const connection = (async () => {
      await client.connect();
      return client;
    })();
    // A lost connection emits 'error'; without a listener Node would end the process.
    client.on('error', () => {
      this.#drop(connection);
    });
    // A connection that failed to open is no longer the current one; its check reports it.
    connection.catch(() => {
      if (this.#client === connection) this.#client = undefined;
    });
    this.#client = connection;
    return connection;
  }

  /**
   * Drops `connection`, which may hold a statement that never answered, and closes it; the next
   * check opens another, unless one already replaced it.
   */
  #drop(connection: Promise<ReadinessClient>): void {
    if (this.#client === connection) this.#client = undefined;
    void connection.then(
      async (connected) => {
        await connected.end().catch(() => undefined);
      },
      () => undefined,
    );
  }
}

const liveResponse = z.object({ status: z.literal('ok') });
const readyResponse = z.object({ status: z.literal('ready') });

/**
 * `/health/live` and `/health/ready`, outside `/v1` and without credentials (SYS-R43, AUT-R20).
 * Liveness checks nothing but the process (SEC-R23); readiness answers 200 or the one 503 body of
 * `NotReady` (SEC-R24, SEC-R26).
 */
export function registerHealth(app: FastifyInstance, readiness: Readiness): void {
  app.get(
    '/health/live',
    { schema: { response: { 200: liveResponse } } },
    () => ({ status: 'ok' }) as const,
  );
  app.get(
    '/health/ready',
    { schema: { response: { 200: readyResponse } } },
    async (request, reply) => {
      if (await readiness.ready()) return { status: 'ready' } as const;
      return await sendProblem(reply, problemResponse(toProblem(new NotReady()), request.id));
    },
  );
}
