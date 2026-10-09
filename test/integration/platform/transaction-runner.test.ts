import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createPool } from '../../../src/platform/db/database.js';
import { ConnectionLost } from '../../../src/platform/db/errors.js';
import { TransactionRunner } from '../../../src/platform/db/transaction-runner.js';
import { closePools, createCustomerAccount, runtimePool } from '../../support/db.js';
import { requireEnv } from '../../support/env.js';

async function backendPid(client: pg.ClientBase): Promise<number> {
  const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  const pid = result.rows[0]?.pid;
  if (pid === undefined) throw new Error('pg_backend_pid() returned no row');
  return pid;
}

/** The backend that waits for a lock held by backend `blocker`, once there is one; fails after 5 s. */
async function blockedBy(blocker: number): Promise<number> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const result = await runtimePool().query<{ pid: number }>(
      'SELECT pid FROM pg_stat_activity WHERE $1::int = ANY (pg_blocking_pids(pid))',
      [blocker],
    );
    const pid = result.rows[0]?.pid;
    if (pid !== undefined) return pid;
    if (Date.now() >= deadline) throw new Error(`No backend was blocked by ${String(blocker)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('transaction runner on a real connection', () => {
  afterAll(async () => {
    await closePools();
  });

  it('SYS-R11 SEC-R57 a backend terminated in the middle of a transaction fails the call with a typed error, keeps the process running and destroys the client', async () => {
    const warnings: Record<string, unknown>[] = [];
    // One connection only, so a client handed back to the pool would be the next one used.
    const pool = createPool({
      connectionString: requireEnv('TEST_DATABASE_URL'),
      max: 1,
      logger: { warn: (fields) => warnings.push(fields) },
    });
    const releases: (Error | boolean | undefined)[] = [];
    const runner = new TransactionRunner({
      pool: {
        async connect() {
          const client = await pool.connect();
          const release = client.release.bind(client);
          client.release = (error?: Error | boolean) => {
            releases.push(error);
            release(error);
          };
          return client;
        },
      },
    });
    const { id } = await createCustomerAccount({ currency: 'EUR' });
    const holder = await runtimePool().connect();
    let victim: number | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [id]);
      const outcome = runner.run(
        async (client) => {
          victim = await backendPid(client);
          await client.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [id]);
          return 'locked';
        },
        { retry: 'movement' },
      );
      const waiting = await blockedBy(await backendPid(holder));
      // The runtime role may end its own role's backends; the owner role may not.
      await holder.query('SELECT pg_terminate_backend($1)', [waiting]);
      // SEC-R57: the lost connection is ConnectionLost, answered 503, with the server's error kept.
      const error: unknown = await outcome.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ConnectionLost);
      expect((error as Error).cause).toBeInstanceOf(pg.DatabaseError);
      expect((error as Error).cause).toMatchObject({ code: '57P01' });
      expect(waiting).toBe(victim);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }

    try {
      expect(releases).toHaveLength(1);
      expect(releases[0]).toBeInstanceOf(Error);
      const next = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      expect(next.rows[0]?.pid).not.toBe(victim);
      expect(pool.totalCount).toBe(1);
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings.every((fields) => Object.keys(fields).join() === 'sqlstate')).toBe(true);
    } finally {
      await pool.end();
    }
  });
});
