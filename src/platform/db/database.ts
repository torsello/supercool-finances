import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.js';

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

/** The Kysely instance over a pool; `destroy()` ends the pool. */
export function createDatabase(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
