import { afterAll, describe, expect, it } from 'vitest';
import { transfer, withdraw } from '../../../src/modules/movements/index.js';
import { createPool } from '../../../src/platform/db/database.js';
import { AccountLockTimeout } from '../../../src/platform/db/errors.js';
import {
  balanceOf,
  closePools,
  createCustomerAccount,
  runtimePool,
  writeDirectDeposit,
} from '../../support/db.js';
import { requireEnv } from '../../support/env.js';
import { openLockSession } from '../../support/sessions.js';
import { C1, C2, customer, movementTransactions, settings, writtenRows } from './support.js';

/** The database's clock, which runs lock_timeout, in milliseconds since the epoch. */
async function databaseClockMs(): Promise<number> {
  const result = await runtimePool().query<{ ms: number }>(
    'SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS ms',
  );
  const ms = result.rows[0]?.ms;
  if (ms === undefined) throw new Error('clock_timestamp() returned no row');
  return ms;
}

describe('movement lock waits', () => {
  afterAll(async () => {
    await closePools();
  });

  it('MOV-R19 MOV-R20 with a session holding the account row, a withdrawal ends with AccountLockTimeout after the lock timeout and writes nothing', async () => {
    const movements = movementTransactions();
    const a1 = await createCustomerAccount({ currency: 'EUR', ownerId: C1 });
    await writeDirectDeposit(a1, '1000');
    const before = await writtenRows();
    const session = await openLockSession();
    try {
      await session.lockRow('accounts', a1.id);
      const startedAt = await databaseClockMs();
      const started = performance.now();
      await expect(
        movements.run(
          async (tx) =>
            await withdraw(
              tx,
              { accountLockTimeoutMs: 200 },
              {
                accountId: a1.id,
                amount: 100n,
                currency: 'EUR',
                actor: customer(C1),
                requestId: 'req-lock-wait',
              },
            ),
        ),
      ).rejects.toBeInstanceOf(AccountLockTimeout);
      expect((await databaseClockMs()) - startedAt).toBeGreaterThanOrEqual(200);
      expect(performance.now() - started).toBeLessThan(5000);
    } finally {
      await session.close();
    }
    expect(await writtenRows()).toEqual(before);
    expect(await balanceOf(a1.id)).toBe('1000');
  });

  it('MOV-R23 twenty crossed transfers between two accounts at the same time all complete, with no 40P01 reaching the caller', async () => {
    // Ten connections, so the transfers really run at the same time.
    const pool = createPool({
      connectionString: requireEnv('TEST_DATABASE_URL'),
      max: 10,
      logger: { warn: () => undefined },
    });
    try {
      const movements = movementTransactions(pool);
      const a1 = await createCustomerAccount({ currency: 'EUR', ownerId: C1 });
      const b1 = await createCustomerAccount({ currency: 'EUR', ownerId: C2 });
      await writeDirectDeposit(a1, '10000');
      await writeDirectDeposit(b1, '10000');

      const outcomes = await Promise.allSettled(
        Array.from({ length: 20 }, async (_, i) => {
          const [source, destination, owner] = i % 2 === 0 ? [a1, b1, C1] : [b1, a1, C2];
          return await movements.run(
            async (tx) =>
              await transfer(tx, settings, {
                accountId: source.id,
                destinationAccountId: destination.id,
                amount: 100n,
                currency: 'EUR',
                actor: customer(owner),
                requestId: `req-crossed-${String(i)}`,
              }),
          );
        }),
      );

      expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toEqual([]);
      expect([await balanceOf(a1.id), await balanceOf(b1.id)]).toEqual(['10000', '10000']);
    } finally {
      await pool.end();
    }
  });
});
