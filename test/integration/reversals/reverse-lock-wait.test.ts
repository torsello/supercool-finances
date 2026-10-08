import { afterAll, describe, expect, it } from 'vitest';
import {
  InsufficientFunds,
  InsufficientFundsForReversal,
  Reversals,
  transfer,
} from '../../../src/modules/movements/index.js';
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
import {
  C1,
  C2,
  customer,
  movementTransactions,
  OPERATOR,
  settings,
  writtenRows,
} from '../movements/support.js';

type Movements = ReturnType<typeof movementTransactions>;

const reversals = new Reversals();

function reverseWith(movements: Movements, transactionId: string, accountLockTimeoutMs = 2000) {
  return movements.run(
    async (tx) =>
      await reversals.reverse(
        tx,
        { accountLockTimeoutMs },
        {
          transactionId,
          reason: 'Operator correction',
          actor: OPERATOR,
          requestId: 'req-reverse',
        },
      ),
  );
}

function transferWith(
  movements: Movements,
  ownerId: string,
  source: string,
  destination: string,
  amount: bigint,
) {
  return movements.run(
    async (tx) =>
      await transfer(tx, settings, {
        accountId: source,
        destinationAccountId: destination,
        amount,
        currency: 'EUR',
        actor: customer(ownerId),
        requestId: 'req-transfer',
      }),
  );
}

/** The database's clock, which runs lock_timeout, in milliseconds since the epoch. */
async function databaseClockMs(): Promise<number> {
  const result = await runtimePool().query<{ ms: number }>(
    'SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS ms',
  );
  const ms = result.rows[0]?.ms;
  if (ms === undefined) throw new Error('clock_timestamp() returned no row');
  return ms;
}

/**
 * Resolves once backend `pid` waits behind backend `ahead`. PostgreSQL queues a second waiter for
 * a row behind the first waiter's tuple lock, so `pg_blocking_pids` names the first waiter, not
 * the session holding the row, and `waitUntilBlocked` cannot see it.
 */
async function waitUntilQueuedBehind(pid: number, ahead: number): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const result = await runtimePool().query<{ queued: boolean }>(
      'SELECT $2::int = ANY (pg_blocking_pids($1::int)) AS queued',
      [pid, ahead],
    );
    if (result.rows[0]?.queued === true) return;
    if (Date.now() >= deadline) {
      throw new Error(`Backend ${String(pid)} was not queued behind ${String(ahead)} in time`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A call's outcome, so a call started before a failed wait never rejects unhandled. */
async function settle(call: Promise<unknown>): Promise<PromiseSettledResult<unknown>> {
  const [outcome] = await Promise.allSettled([call]);
  return outcome;
}

/** The sum of an account's entries, which its cached balance must equal (LED-R19). */
async function entriesSum(accountId: string): Promise<string> {
  const result = await runtimePool().query<{ sum: string }>(
    'SELECT COALESCE(SUM(amount), 0)::text AS sum FROM ledger_entries WHERE account_id = $1',
    [accountId],
  );
  return result.rows[0]?.sum ?? 'none';
}

describe('reversal lock waits', () => {
  afterAll(async () => {
    await closePools();
  });

  it('REV-R19 with a session holding the account row, a reversal ends with AccountLockTimeout after the lock timeout and writes nothing', async () => {
    const movements = movementTransactions();
    const a1 = await createCustomerAccount({ currency: 'EUR', ownerId: C1 });
    const { transactionId: d } = await writeDirectDeposit(a1, '1000');
    const before = await writtenRows();
    const session = await openLockSession();
    try {
      await session.lockRow('accounts', a1.id);
      const startedAt = await databaseClockMs();
      const started = performance.now();
      await expect(reverseWith(movements, d, 200)).rejects.toBeInstanceOf(AccountLockTimeout);
      expect((await databaseClockMs()) - startedAt).toBeGreaterThanOrEqual(200);
      expect(performance.now() - started).toBeLessThan(5000);
    } finally {
      await session.close();
    }
    expect(await writtenRows()).toEqual(before);
    expect(await balanceOf(a1.id)).toBe('1000');

    // Once the lock is released, the same reversal applies.
    await reverseWith(movements, d);
    expect(await balanceOf(a1.id)).toBe('0');
  });

  it('REV-R20 a reversal and a transfer forced to contend for the same accounts never let a balance go below zero', async () => {
    // One connection each, so each call's backend is known and they really run at the same time.
    const pools = [0, 1].map(() =>
      createPool({
        connectionString: requireEnv('TEST_DATABASE_URL'),
        max: 1,
        logger: { warn: () => undefined },
      }),
    );
    const [reversalPool, transferPool] = pools;
    if (reversalPool === undefined || transferPool === undefined) throw new Error('no pools');
    const session = await openLockSession();
    try {
      const reversalMovements = movementTransactions(reversalPool);
      const transferMovements = movementTransactions(transferPool);
      /** The backend of a one-connection pool, which its next transaction runs on. */
      const backendOf = async (pool: typeof reversalPool) => {
        const client = await pool.connect();
        try {
          return await session.backendPid(client);
        } finally {
          client.release();
        }
      };

      for (let run = 0; run < 10; run += 1) {
        const accounts = [
          await createCustomerAccount({ currency: 'EUR', ownerId: C1 }),
          await createCustomerAccount({ currency: 'EUR', ownerId: C2 }),
        ];
        // B1 is the lower id, so the reversal and the transfer both lock it first.
        const [b1, a1] = accounts.toSorted((x, y) => (x.id < y.id ? -1 : 1));
        if (a1 === undefined || b1 === undefined) throw new Error('no accounts');
        await writeDirectDeposit(a1, '5000');
        const t = await transferWith(reversalMovements, a1.ownerId, a1.id, b1.id, 1000n);
        const reversalPid = await backendOf(reversalPool);
        const transferPid = await backendOf(transferPool);

        // With B1 held, the first call waits for the session and the second queues behind it, so
        // both are in flight when the lock is released and the first takes B1. The order
        // alternates, so both outcomes are proven.
        const reversalFirst = run % 2 === 0;
        const startReversal = () => settle(reverseWith(reversalMovements, t.transactionId));
        const startTransfer = () =>
          settle(transferWith(transferMovements, b1.ownerId, b1.id, a1.id, 600n));
        await session.lockRow('accounts', b1.id);
        let reversalCall: Promise<PromiseSettledResult<unknown>>;
        let transferCall: Promise<PromiseSettledResult<unknown>>;
        try {
          if (reversalFirst) {
            reversalCall = startReversal();
            await session.waitUntilBlocked(reversalPid);
            transferCall = startTransfer();
            await waitUntilQueuedBehind(transferPid, reversalPid);
          } else {
            transferCall = startTransfer();
            await session.waitUntilBlocked(transferPid);
            reversalCall = startReversal();
            await waitUntilQueuedBehind(reversalPid, transferPid);
          }
        } finally {
          await session.release();
        }
        const [reversal, back] = [await reversalCall, await transferCall];

        const balances = [await balanceOf(a1.id), await balanceOf(b1.id)];
        if (reversalFirst) {
          expect(reversal.status).toBe('fulfilled');
          expect(back.status === 'rejected' && back.reason).toBeInstanceOf(InsufficientFunds);
          expect(balances).toEqual(['5000', '0']);
        } else {
          expect(back.status).toBe('fulfilled');
          expect(reversal.status === 'rejected' && reversal.reason).toBeInstanceOf(
            InsufficientFundsForReversal,
          );
          expect(balances).toEqual(['4600', '400']);
        }
        expect([await entriesSum(a1.id), await entriesSum(b1.id)]).toEqual(balances);
      }
    } finally {
      await session.close();
      await Promise.all(
        pools.map(async (pool) => {
          await pool.end();
        }),
      );
    }
  });
});
