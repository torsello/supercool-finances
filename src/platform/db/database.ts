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
  logger: PoolLogger;
}

/**
 * A `pg` pool whose `int8` and `numeric` values are exact strings. A pooled connection that is
 * lost while idle (a terminated backend, a database restart or failover) makes the pool emit
 * `'error'`; without a listener Node would end the process. The listener logs it at `warn` with
 * the SQLSTATE only, never the error message or the connection string, which can hold the host
 * or credentials; pg has already removed the broken client, and the next query opens a new one.
 */
export function createPool(options: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    ...(options.max === undefined ? {} : { max: options.max }),
    types: exactTypes(),
  });
  pool.on('error', (error) => {
    options.logger.warn(
      { sqlstate: error instanceof pg.DatabaseError ? (error.code ?? null) : null },
      'idle database connection lost',
    );
  });
  return pool;
}

/** The Kysely instance over a pool; `destroy()` ends the pool. */
export function createDatabase(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
