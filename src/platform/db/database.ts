import { Kysely, PostgresDialect, type PostgresPool, type PostgresPoolClient } from 'kysely';
import pg from 'pg';
import { CLIENT_SIDE_LIMIT_MS, RequestTimeout, type RunScope } from '../http/request-timeout.js';
import { ConnectionLost, PoolAcquireTimeout, PoolClosed } from './errors.js';
import type { Database } from './schema.js';
import { classifyDatabaseError, isConnectionLoss, isProxyBorrowTimeout } from './sqlstate.js';

/** pg's array of `text`, whose parser keeps every element a string (or null). */
const TEXT_ARRAY_OID = 1009;
const INT8_ARRAY_OID = 1016;
const NUMERIC_ARRAY_OID = 1231;

/**
 * Type parsers of every pool: `int8`, `numeric` and arrays of either stay exact decimal strings,
 * whatever another module sets on pg's global parsers (ADR-0010, LED-R27). pg's defaults would
 * turn `numeric[]` into JavaScript floats. Every other type keeps pg's default.
 */
function exactTypes(): pg.TypeOverrides {
  const types = new pg.TypeOverrides();
  // pg's text-array parser returns the elements as written, without converting them. @types/pg
  // types every parser as taking a number, so the cast goes through unknown.
  const parseStringArray = types.getTypeParser(TEXT_ARRAY_OID, 'text') as unknown as (
    value: string,
  ) => (string | null)[];
  types.setTypeParser(pg.types.builtins.INT8, 'text', (value: string) => value);
  types.setTypeParser(pg.types.builtins.NUMERIC, 'text', (value: string) => value);
  types.setTypeParser(INT8_ARRAY_OID, 'text', parseStringArray);
  types.setTypeParser(NUMERIC_ARRAY_OID, 'text', parseStringArray);
  return types;
}

/** The part of a logger the pool needs; pino's `warn(fields, message)` fits it. */
export interface PoolLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface PoolOptions {
  connectionString: string;
  max?: number;
  /** How long a new connection may take before `connect()` fails; pg waits forever by default. */
  connectionTimeoutMillis?: number;
  logger: PoolLogger;
}

function sqlstateOf(error: Error): string | null {
  return error instanceof pg.DatabaseError ? (error.code ?? null) : null;
}

/**
 * A `pg` pool whose `int8` and `numeric` values are exact strings. A lost connection (a terminated
 * backend, a database restart or failover) makes its client emit `'error'`, and the pool too while
 * the client is idle; without a listener Node would end the process. pg-pool listens on idle
 * clients only, so every client gets its own listener when it connects, which covers a client
 * checked out by a request. A loss is logged at `warn` with the SQLSTATE only, never the error
 * message or the connection string, which can hold the host or credentials; the request that holds
 * a broken client fails, and pg removes the client, so the next query opens a new one.
 */
export function createPool(options: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    ...(options.max === undefined ? {} : { max: options.max }),
    ...(options.connectionTimeoutMillis === undefined
      ? {}
      : { connectionTimeoutMillis: options.connectionTimeoutMillis }),
    types: exactTypes(),
  });
  pool.on('error', (error) => {
    options.logger.warn({ sqlstate: sqlstateOf(error) }, 'idle database connection lost');
  });
  // An idle client's loss is logged once, by the pool's listener above. A checked-out client's
  // listener may log one loss twice: pg reports the server's error, then the closed socket.
  const checkedOut = new WeakSet<pg.PoolClient>();
  pool.on('acquire', (client) => checkedOut.add(client));
  pool.on('release', (_error, client) => checkedOut.delete(client));
  pool.on('connect', (client) => {
    client.on('error', (error) => {
      if (!checkedOut.has(client)) return;
      options.logger.warn({ sqlstate: sqlstateOf(error) }, 'database connection lost');
    });
  });
  return pool;
}

/** What the request pool reports for the metrics of section 1.4 of spec 007. */
export interface AcquireObserver {
  poolAcquireTimeout(): void;
}

/** pg-pool's errors when no connection is handed out within `connectionTimeoutMillis`. */
const ACQUIRE_TIMEOUT_MESSAGES = [
  'timeout exceeded when trying to connect',
  'Connection terminated due to connection timeout',
];

/** pg-pool's error for a connection asked of a pool that was ended. */
const POOL_ENDED_MESSAGE = 'Cannot use a pool after calling end on the pool';

/** The part of a pool the request code uses. */
export interface RequestPool {
  connect(): Promise<pg.PoolClient>;
  end(): Promise<void>;
}

/**
 * The request pool as the transaction runner and Kysely use it: when no connection becomes free
 * within `DB_POOL_ACQUIRE_TIMEOUT_MS` (the pool's `connectionTimeoutMillis`), the wait ends with
 * `PoolAcquireTimeout`, answered 503 before any statement is sent, and is counted (SEC-R37).
 * pg-pool serves the requests waiting for a connection in arrival order (SEC-R38). A connection
 * asked after the shutdown ended the pool is `PoolClosed`, a 503 too (SYS-R34).
 */
export function acquiringPool(pool: pg.Pool, observer: AcquireObserver): RequestPool {
  return {
    async connect() {
      try {
        return await pool.connect();
      } catch (error) {
        if (error instanceof Error && ACQUIRE_TIMEOUT_MESSAGES.includes(error.message)) {
          observer.poolAcquireTimeout();
          throw new PoolAcquireTimeout({ cause: error });
        }
        if (error instanceof Error && error.message === POOL_ENDED_MESSAGE) {
          throw new PoolClosed({ cause: error });
        }
        throw error;
      }
    },
    end: async () => {
      await pool.end();
    },
  };
}

/** Marks the deadline winning a race. */
const TIMED_OUT = Symbol('timed out');

async function raceDeadline<T>(work: Promise<T>, scope: RunScope | undefined): Promise<T> {
  if (scope === undefined) return await work;
  const outcome = await Promise.race([
    work.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    ),
    scope.deadline.whenPassed.then((): typeof TIMED_OUT => TIMED_OUT),
  ]);
  if (outcome === TIMED_OUT) throw new RequestTimeout();
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}

/**
 * A connection of the reads and single statements Kysely runs outside a transaction, for one
 * request (SEC-R33): a statement past the deadline is refused; at the deadline the statement in
 * flight answers `RequestTimeout` at once while it runs on, and the connection goes back to the
 * pool only once it ends, or is destroyed when it sends no reply within the client-side limit.
 * The connection is held in the request's scope until then, so the shutdown waits for it. A
 * statement cancelled by `statement_timeout` is `StatementTimeout` (SEC-R32).
 */
function readConnection(client: pg.PoolClient, scope: RunScope | undefined): PostgresPoolClient {
  let inFlight: Promise<unknown> = Promise.resolve();
  // Set by RDS Proxy's borrow timeout: the connection is then destroyed, not reused (SEC-R49).
  let broken: Error | undefined;
  let released = false;
  let limit: unknown;
  // Once only, and never throwing: it runs from timers and promise callbacks, where an error would
  // be an unhandled rejection, which ends the process.
  const release = (error?: Error) => {
    if (released) return;
    released = true;
    if (limit !== undefined) scope?.deadline.timers.clearTimeout(limit);
    try {
      client.release(error);
    } catch {
      // The pool already took the connection back, or refused it; there is nothing left to give.
    } finally {
      unhold();
    }
  };
  const unhold =
    scope?.hold({
      destroy: () => {
        release(new Error('connection destroyed at the shutdown deadline'));
      },
    }) ?? (() => undefined);
  const query = async (text: string, values: readonly unknown[]) => {
    if (scope?.deadline.passed === true) throw new RequestTimeout();
    const statement = client.query(text, [...values]);
    inFlight = statement.catch(() => undefined);
    try {
      return await raceDeadline(statement, scope);
    } catch (error) {
      if (isProxyBorrowTimeout(error)) {
        broken ??= new Error('the database proxy found no connection in time', { cause: error });
      }
      // A lost connection answers 503 and is destroyed, never reused (SEC-R57).
      if (isConnectionLoss(error)) {
        broken ??= new Error('database connection lost', { cause: error });
        throw new ConnectionLost({ cause: error });
      }
      throw classifyDatabaseError(error, 'work');
    }
  };
  return {
    // Only the (sql, parameters) overload is implemented: Kysely calls the cursor overload only to
    // stream, which the service never does, so the cast goes through unknown.
    query: query as unknown as PostgresPoolClient['query'],
    release() {
      if (scope?.deadline.passed === true && limit === undefined) {
        limit = scope.deadline.timers.setTimeout(() => {
          release(new Error('the statement in flight sent no reply within the client-side limit'));
        }, CLIENT_SIDE_LIMIT_MS);
      }
      void inFlight.then(() => {
        release(broken);
      });
    },
  };
}

/**
 * Kysely's pool for one request at a time: the request's deadline, from `scope`, bounds the wait
 * for a connection too; a connection handed out after the deadline goes back unused.
 */
function readPool(pool: RequestPool, scope: () => RunScope | undefined): PostgresPool {
  return {
    async connect() {
      const current = scope();
      if (current?.deadline.passed === true) throw new RequestTimeout();
      const acquiring = pool.connect();
      try {
        return readConnection(await raceDeadline(acquiring, current), current);
      } catch (error) {
        if (error instanceof RequestTimeout) {
          void acquiring.then(
            (client) => {
              client.release();
            },
            () => undefined,
          );
        }
        throw error;
      }
    },
    end: async () => {
      await pool.end();
    },
    options: {},
  };
}

/**
 * The Kysely instance over the request pool; `destroy()` ends the pool. With `scope`, the reads
 * of a request answer at its deadline (SEC-R33).
 */
export function createDatabase(
  pool: pg.Pool | RequestPool,
  scope: () => RunScope | undefined = () => undefined,
): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool: readPool(pool, scope) }) });
}
