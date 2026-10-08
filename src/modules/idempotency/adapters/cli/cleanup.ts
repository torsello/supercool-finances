import pg from 'pg';
import { createPool } from '../../../../platform/db/database.js';

interface Output {
  write(text: string): unknown;
}

/** The part of a `pg` pool the command uses. */
export interface CleanupPool {
  connect(): Promise<pg.PoolClient>;
  end(): Promise<void>;
}

export interface CleanupOptions {
  databaseUrl: string | undefined;
  stdout: Output;
  stderr: Output;
  /** Opens the pool; tests wrap it to capture the statements of the command's connection. */
  openPool?: (connectionString: string) => CleanupPool;
}

/** Rows deleted per batch, each batch in its own database transaction (IDM-R22). */
export const CLEANUP_BATCH_SIZE = 1000;

/** How long the command waits to connect before it exits 2. */
export const CLEANUP_CONNECTION_TIMEOUT_MS = 10_000;

/**
 * One batch: up to 1000 expired rows, oldest expiry first, skipping rows a request in progress
 * holds instead of waiting for them (plan 005 section 4).
 */
const DELETE_BATCH = `WITH doomed AS (
    SELECT user_id, key FROM idempotency_keys WHERE expires_at <= now()
    ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED
  )
  DELETE FROM idempotency_keys k USING doomed d WHERE k.user_id = d.user_id AND k.key = d.key`;

/**
 * The command's own pool: one connection, a bounded connect, so a database that drops packets
 * ends in exit 2 instead of a hang, and warnings with the SQLSTATE only.
 */
export function openCleanupPool(connectionString: string, stderr: Output): pg.Pool {
  return createPool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: CLEANUP_CONNECTION_TIMEOUT_MS,
    logger: {
      warn: (fields, message) => {
        stderr.write(`${JSON.stringify({ message, ...fields })}\n`);
      },
    },
  });
}

/** The SQLSTATE of a driver error, also behind a wrapping error; never its message. */
function sqlstateOf(error: unknown): string | null {
  if (error instanceof pg.DatabaseError) return error.code ?? null;
  if (error instanceof Error && error.cause !== undefined) return sqlstateOf(error.cause);
  return null;
}

/** Deletes one batch in its own transaction, with the maintenance statement timeout (SEC-R48). */
async function deleteBatch(client: pg.PoolClient): Promise<number> {
  await client.query('BEGIN');
  await client.query('SELECT app.set_statement_timeout(600000)');
  const result = await client.query(DELETE_BATCH, [CLEANUP_BATCH_SIZE]);
  await client.query('COMMIT');
  return result.rowCount ?? 0;
}

/**
 * `npm run idempotency:cleanup` (plan 005 section 4): deletes every expired key row against
 * `databaseUrl`, in batches of 1000 until a batch deletes fewer, prints `{"deleted": n}` on one line
 * and exits 0; exits 2 with a fixed message and the SQLSTATE on stderr when it cannot connect or a
 * statement fails. No output carries the URL or a driver message, which can hold credentials
 * (IDM-R22). It never runs inside the service, so replicas never race on it.
 */
export async function runCleanup(options: CleanupOptions): Promise<0 | 2> {
  const { stdout, stderr } = options;
  if (options.databaseUrl === undefined || options.databaseUrl === '') {
    stderr.write('idempotency-cleanup: DATABASE_URL is not set\n');
    return 2;
  }
  const pool = (options.openPool ?? ((url: string) => openCleanupPool(url, stderr)))(
    options.databaseUrl,
  );
  try {
    const client = await pool.connect();
    let broken: Error | undefined;
    try {
      let deleted = 0;
      for (;;) {
        const batch = await deleteBatch(client);
        deleted += batch;
        if (batch < CLEANUP_BATCH_SIZE) break;
      }
      stdout.write(`${JSON.stringify({ deleted })}\n`);
      return 0;
    } catch (error) {
      // Committed batches stay deleted; the open one, if any, ends with the destroyed connection.
      broken = new Error('cleanup failed', { cause: error });
      throw error;
    } finally {
      client.release(broken);
    }
  } catch (error) {
    stderr.write(
      `${JSON.stringify({ error: 'idempotency cleanup could not run', sqlstate: sqlstateOf(error) })}\n`,
    );
    return 2;
  } finally {
    await pool.end();
  }
}
