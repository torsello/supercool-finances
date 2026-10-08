import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createPool } from '../../../src/platform/db/database.js';
import { TransactionRunner } from '../../../src/platform/db/transaction-runner.js';
import {
  UnitOfWorkRunner,
  type FaultStep,
  type UnitOfWork,
} from '../../../src/platform/db/unit-of-work.js';
import { closePools, runtimePool } from '../../support/db.js';
import { requireEnv } from '../../support/env.js';

/**
 * A pool whose clients record the text of every statement they are sent, in order, until they are
 * released. The recorder wraps the driver inside the test process only (plan 000 section 9).
 */
function recordingPool(base: pg.Pool, statements: string[]): { connect(): Promise<pg.PoolClient> } {
  return {
    async connect() {
      const client = await base.connect();
      const recorded = client as unknown as { query?: (...args: unknown[]) => unknown };
      const query = client.query.bind(client) as (...args: unknown[]) => unknown;
      const release = client.release.bind(client);
      recorded.query = (...args) => {
        if (typeof args[0] === 'string') statements.push(args[0]);
        return query(...args);
      };
      client.release = (error?: Error | boolean) => {
        // The own property shadowed the prototype's query; deleting it restores the driver's.
        delete recorded.query;
        release(error);
      };
      return client;
    },
  };
}

/** Inserts an empty active customer account on the unit of work's connection. */
async function insertAccount(uow: UnitOfWork, id: string): Promise<void> {
  await uow.db
    .insertInto('accounts')
    .values({
      id,
      kind: 'customer',
      owner_id: randomUUID(),
      currency: 'EUR',
      status: 'active',
      balance: '0',
    })
    .execute();
}

async function accountExists(id: string): Promise<boolean> {
  const result = await runtimePool().query('SELECT 1 FROM accounts WHERE id = $1', [id]);
  return result.rowCount === 1;
}

describe('unit of work', () => {
  afterAll(async () => {
    await closePools();
  });

  it('SYS-R11 a rollback to the savepoint keeps the writes before it and drops the ones after it', async () => {
    const before = randomUUID();
    const after = randomUUID();
    const unitOfWork = new UnitOfWorkRunner(new TransactionRunner({ pool: runtimePool() }));
    await unitOfWork.run(
      async (uow) => {
        await insertAccount(uow, before);
        await uow.savepoint('work');
        await insertAccount(uow, after);
        await uow.rollbackToSavepoint('work');
      },
      { retry: 'none' },
    );
    expect(await accountExists(before)).toBe(true);
    expect(await accountExists(after)).toBe(false);
  });

  it('MOV-R19 SEC-R31 sets the lock timeout through app.set_lock_timeout, for the transaction only', async () => {
    // One connection only, so the check after the transaction runs on the same client.
    const single = createPool({
      connectionString: requireEnv('TEST_DATABASE_URL'),
      max: 1,
      logger: {
        warn: (fields, message) => {
          console.warn(message, fields);
        },
      },
    });
    try {
      const statements: string[] = [];
      const unitOfWork = new UnitOfWorkRunner(
        new TransactionRunner({ pool: recordingPool(single, statements) }),
      );
      const inside = await unitOfWork.run(
        async (uow) => {
          await uow.setLockTimeout(300);
          const shown = await sql<{
            lock_timeout: string;
            pid: number;
          }>`SELECT current_setting('lock_timeout') AS lock_timeout, pg_backend_pid() AS pid`.execute(
            uow.db,
          );
          return shown.rows[0];
        },
        { retry: 'none' },
      );
      expect(inside?.lock_timeout).toBe('300ms');
      expect(statements.filter((text) => /lock_timeout/i.test(text))).toEqual([
        'SELECT app.set_lock_timeout($1::integer)',
        "SELECT current_setting('lock_timeout') AS lock_timeout, pg_backend_pid() AS pid",
      ]);
      expect(statements.some((text) => /^\s*(SET|RESET|DISCARD)\b/i.test(text))).toBe(false);
      expect(statements.some((text) => /set_config/i.test(text))).toBe(false);

      const after = await single.query<{ lock_timeout: string; pid: number }>(
        "SELECT current_setting('lock_timeout') AS lock_timeout, pg_backend_pid() AS pid",
      );
      expect(after.rows[0]).toEqual({ lock_timeout: '0', pid: inside?.pid });
    } finally {
      await single.end();
    }
  });

  it('SYS-R11 the fault hook throws at a named step, and nothing of the transaction is committed', async () => {
    const id = randomUUID();
    const reached: FaultStep[] = [];
    const fault = new Error('fault injected at after-entries');
    const unitOfWork = new UnitOfWorkRunner(new TransactionRunner({ pool: runtimePool() }), {
      faults: {
        atStep(step) {
          reached.push(step);
          if (step === 'after-entries') throw fault;
        },
      },
    });
    await expect(
      unitOfWork.run(
        async (uow) => {
          await insertAccount(uow, id);
          uow.reached('after-entries');
          uow.reached('after-balances');
        },
        { retry: 'none' },
      ),
    ).rejects.toBe(fault);
    expect(reached).toEqual(['after-entries']);
    expect(await accountExists(id)).toBe(false);
  });

  it('SYS-R11 without a fault hook, reaching a named step changes nothing', async () => {
    const id = randomUUID();
    const unitOfWork = new UnitOfWorkRunner(new TransactionRunner({ pool: runtimePool() }));
    await unitOfWork.run(
      async (uow) => {
        await insertAccount(uow, id);
        uow.reached('after-entries');
        uow.reached('after-balances');
      },
      { retry: 'none' },
    );
    expect(await accountExists(id)).toBe(true);
  });
});
