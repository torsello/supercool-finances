import pg from 'pg';
import { requireEnv } from './env.js';

export interface LockSession {
  /** This session's backend pid, the blocker other backends wait for. */
  readonly pid: number;
  /** Begins a transaction if none is open and locks one row of a table by id. */
  lockRow(table: 'accounts' | 'transactions', id: string, mode?: RowLockMode): Promise<void>;
  /** Begins a transaction if none is open and runs a statement that takes a lock. */
  lock(text: string, values?: unknown[]): Promise<void>;
  /** The backend pid of another connection, for `waitUntilBlocked`. */
  backendPid(client: pg.ClientBase): Promise<number>;
  /** Resolves once backend `pid` waits for a lock this session holds; fails after `timeoutMs`. */
  waitUntilBlocked(pid: number, options?: { timeoutMs?: number }): Promise<void>;
  /** Rolls back, releasing every lock this session holds. */
  release(): Promise<void>;
  /** Releases the locks and closes the session. */
  close(): Promise<void>;
}

export type RowLockMode = 'FOR UPDATE' | 'FOR NO KEY UPDATE';

/**
 * A separate session as the owner role, through `TEST_MIGRATION_DATABASE_URL` (plan 000 section 9):
 * the runtime role's `idle_in_transaction_session_timeout` never ends a lock a slow test still
 * needs, and the owner may take table locks. Tests wait for a backend to be blocked instead of
 * sleeping a fixed time. Blocking is read with `pg_blocking_pids`: the owner role cannot see the
 * runtime role's `wait_event_type` in `pg_stat_activity`, which only the same role or
 * `pg_read_all_stats` may read.
 */
export async function openLockSession(): Promise<LockSession> {
  const client = new pg.Client({ connectionString: requireEnv('TEST_MIGRATION_DATABASE_URL') });
  await client.connect();
  const own = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  const ownPid = own.rows[0]?.pid;
  if (ownPid === undefined) throw new Error('pg_backend_pid() returned no row');
  let open = false;

  async function begin(): Promise<void> {
    if (!open) {
      await client.query('BEGIN');
      open = true;
    }
  }

  async function release(): Promise<void> {
    if (open) {
      open = false;
      await client.query('ROLLBACK');
    }
  }

  return {
    pid: ownPid,
    async lockRow(table, id, mode = 'FOR UPDATE') {
      await begin();
      // table and mode are closed unions, never caller-supplied text.
      const result = await client.query(`SELECT id FROM ${table} WHERE id = $1 ${mode}`, [id]);
      if (result.rowCount !== 1) throw new Error(`No row ${id} in ${table} to lock`);
    },
    async lock(text, values = []) {
      await begin();
      await client.query(text, values);
    },
    async backendPid(other) {
      const result = await other.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const pid = result.rows[0]?.pid;
      if (pid === undefined) throw new Error('pg_backend_pid() returned no row');
      return pid;
    },
    async waitUntilBlocked(pid, { timeoutMs = 5000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const result = await client.query<{ blocked: boolean }>(
          'SELECT $2::int = ANY (pg_blocking_pids($1::int)) AS blocked',
          [pid, ownPid],
        );
        if (result.rows[0]?.blocked === true) return;
        if (Date.now() >= deadline) {
          throw new Error(
            `Backend ${String(pid)} was not blocked by this session within ${String(timeoutMs)} ms`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    release,
    async close() {
      try {
        await release();
      } finally {
        await client.end();
      }
    },
  };
}
