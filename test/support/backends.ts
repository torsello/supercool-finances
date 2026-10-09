import { runtimePool } from './db.js';

/**
 * The backends of the runtime role that wait for a lock, read from `pg_stat_activity` with
 * `pg_blocking_pids` as the runtime role itself, which sees its own sessions in full (plan 000
 * section 9): only those blocked by `by` when it is given. Polls until exactly `count` of them
 * wait, never sleeping a fixed time, and fails after `timeoutMs`.
 */
export async function blockedBackends(options: {
  count: number;
  by?: number;
  timeoutMs?: number;
}): Promise<number[]> {
  const deadline = Date.now() + (options.timeoutMs ?? 5000);
  for (;;) {
    const result = await runtimePool().query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
        WHERE usename = current_user AND pid <> pg_backend_pid()
          AND ($1::int IS NULL AND cardinality(pg_blocking_pids(pid)) > 0
               OR $1::int = ANY (pg_blocking_pids(pid)))
        ORDER BY backend_start`,
      [options.by ?? null],
    );
    const pids = result.rows.map((row) => row.pid);
    if (pids.length === options.count) return pids;
    if (Date.now() >= deadline) {
      throw new Error(
        `expected ${String(options.count)} blocked backends, found ${String(pids.length)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Resolves once backend `pid` waits for a lock held by backend `blocker`. */
export async function waitUntilBlockedBy(
  pid: number,
  blocker: number,
  { timeoutMs = 5000 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await runtimePool().query<{ blocked: boolean }>(
      'SELECT $2::int = ANY (pg_blocking_pids($1::int)) AS blocked',
      [pid, blocker],
    );
    if (result.rows[0]?.blocked === true) return;
    if (Date.now() >= deadline) {
      throw new Error(`backend ${String(pid)} was not blocked by ${String(blocker)} in time`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The backends that `pid` waits for, as `pg_blocking_pids` reports them. */
export async function blockersOf(pid: number): Promise<number[]> {
  const result = await runtimePool().query<{ blockers: number[] }>(
    'SELECT pg_blocking_pids($1::int) AS blockers',
    [pid],
  );
  return result.rows[0]?.blockers ?? [];
}
