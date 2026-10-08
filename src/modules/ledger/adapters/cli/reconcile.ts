import pg from 'pg';
import { createPool } from '../../../../platform/db/database.js';
import { UnitOfWork } from '../../../../platform/db/unit-of-work.js';
import { reconcile } from '../../application/reconciliation.js';
import { KyselyReconciliation } from '../persistence/kysely-reconciliation.js';

interface Output {
  write(text: string): unknown;
}

/** The part of a `pg` pool the command uses. */
export interface ReconcilePool {
  connect(): Promise<pg.PoolClient>;
  end(): Promise<void>;
}

export interface ReconcileOptions {
  databaseUrl: string | undefined;
  stdout: Output;
  stderr: Output;
  /** Opens the pool; tests wrap it to capture the statements of the command's connection. */
  openPool?: (connectionString: string) => ReconcilePool;
}

/** How long the command waits to connect before it exits 2 (LED-R21). */
export const RECONCILE_CONNECTION_TIMEOUT_MS = 10_000;

/**
 * The command's own pool: one connection, a bounded connect, so a database that drops packets
 * ends in exit 2 instead of a hang, and warnings with the SQLSTATE only.
 */
export function openReconcilePool(connectionString: string, stderr: Output): pg.Pool {
  return createPool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: RECONCILE_CONNECTION_TIMEOUT_MS,
    logger: {
      warn: (fields, message) => {
        stderr.write(`${JSON.stringify({ message, ...fields })}\n`);
      },
    },
  });
}

/** The SQLSTATE of a driver error, also behind a typed error; never its message (LED-R21). */
function sqlstateOf(error: unknown): string | null {
  if (error instanceof pg.DatabaseError) return error.code ?? null;
  if (error instanceof Error && error.cause !== undefined) return sqlstateOf(error.cause);
  return null;
}

/**
 * `npm run reconcile` (plan 002 section 5): one REPEATABLE READ, READ ONLY transaction against
 * `databaseUrl`, with the statement timeout of the maintenance scripts (SEC-R48), the report as
 * one JSON line on stdout, and exit 0 when clean, 1 on drift, 2 when it cannot run. No output
 * carries the URL or a driver message, which can hold credentials (LED-R21).
 */
export async function runReconcile(options: ReconcileOptions): Promise<0 | 1 | 2> {
  const { stdout, stderr } = options;
  if (options.databaseUrl === undefined || options.databaseUrl === '') {
    stderr.write('reconcile: DATABASE_URL is not set\n');
    return 2;
  }
  const pool = (options.openPool ?? ((url: string) => openReconcilePool(url, stderr)))(
    options.databaseUrl,
  );
  try {
    const client = await pool.connect();
    let broken: Error | undefined;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      await client.query('SELECT app.set_statement_timeout(600000)');
      const result = await reconcile(new KyselyReconciliation(new UnitOfWork(client).db));
      await client.query('COMMIT');
      stdout.write(`${JSON.stringify(result.report)}\n`);
      return result.exitCode;
    } catch (error) {
      // The transaction only reads, so nothing is lost; the connection is destroyed on release.
      broken = new Error('reconciliation failed', { cause: error });
      throw error;
    } finally {
      client.release(broken);
    }
  } catch (error) {
    stderr.write(
      `${JSON.stringify({ error: 'reconciliation could not run', sqlstate: sqlstateOf(error) })}\n`,
    );
    return 2;
  } finally {
    await pool.end();
  }
}
