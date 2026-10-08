import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { KyselyLedgerWriter } from '../../../src/modules/ledger/adapters/persistence/kysely-ledger.js';
import { LedgerTransaction } from '../../../src/modules/ledger/index.js';
import { KyselyAuditLog } from '../../../src/platform/audit/kysely-audit-log.js';
import { TransactionRunner } from '../../../src/platform/db/transaction-runner.js';
import { UnitOfWorkRunner, type FaultStep } from '../../../src/platform/db/unit-of-work.js';
import { UuidV7Generator } from '../../../src/platform/ids/uuid-v7.js';
import {
  balanceOf,
  closePools,
  createCustomerAccount,
  runtimePool,
  settlementAccountId,
  TEST_OPERATOR_ID,
  writeDirectDeposit,
} from '../../support/db.js';
import { openLockSession } from '../../support/sessions.js';

const ids = new UuidV7Generator();

async function customer(balance?: string) {
  const account = await createCustomerAccount({ currency: 'EUR' });
  if (balance !== undefined) await writeDirectDeposit(account, balance);
  return { id: account.id, kind: 'customer' as const, currency: 'EUR' as const };
}

async function settlement() {
  return {
    id: await settlementAccountId('EUR'),
    kind: 'system' as const,
    currency: 'EUR' as const,
  };
}

async function rowVersion(id: string): Promise<{ xmin: string; balance: string | null }> {
  const result = await runtimePool().query<{ xmin: string; balance: string | null }>(
    'SELECT xmin::text AS xmin, balance FROM accounts WHERE id = $1',
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`No account ${id}`);
  return row;
}

async function storedEntries(transactionId: string): Promise<[string, string][]> {
  const result = await runtimePool().query<{ account_id: string; amount: string }>(
    'SELECT account_id, amount FROM ledger_entries WHERE transaction_id = $1 ORDER BY id',
    [transactionId],
  );
  return result.rows.map((row) => [row.account_id, row.amount]);
}

async function storedKind(transactionId: string): Promise<string | undefined> {
  const result = await runtimePool().query<{ kind: string }>(
    'SELECT kind FROM transactions WHERE id = $1',
    [transactionId],
  );
  return result.rows[0]?.kind;
}

describe('ledger writer', () => {
  const unitOfWork = new UnitOfWorkRunner(new TransactionRunner({ pool: runtimePool() }));

  afterAll(async () => {
    await closePools();
  });

  it('LED-R11 LED-R14 append writes the transaction and its entries, changes only customer balances, and never updates or locks a settlement row', async () => {
    const a1 = await customer('1000');
    const b1 = await customer();
    const s = await settlement();
    const before = await rowVersion(s.id);

    // FOR NO KEY UPDATE conflicts with FOR UPDATE, FOR NO KEY UPDATE and FOR SHARE, and with any
    // update of the row, but not with the FOR KEY SHARE of the entries' foreign key (LED-R14).
    const session = await openLockSession();
    let appended;
    try {
      await session.lockRow('accounts', s.id, 'FOR NO KEY UPDATE');
      appended = await unitOfWork.run(
        async (uow) => {
          await uow.setLockTimeout(1000);
          const writer = new KyselyLedgerWriter(uow, ids);
          const audit = new KyselyAuditLog(uow.db, ids);
          const results = [];
          for (const transaction of [
            LedgerTransaction.deposit(a1, s, 500n),
            LedgerTransaction.withdrawal(a1, s, 200n),
            LedgerTransaction.transfer(a1, b1, 300n),
          ]) {
            const result = await writer.append(transaction);
            await audit.record({
              actorId: TEST_OPERATOR_ID,
              actorRole: 'operator',
              action: transaction.kind as 'deposit' | 'withdrawal' | 'transfer',
              accountIds: transaction.balanceChanges().map((change) => change.accountId),
              transactionId: result.transactionId,
              requestId: 'test-ledger-writer',
            });
            results.push(result);
          }
          return results;
        },
        { retry: 'none' },
      );
    } finally {
      await session.close();
    }
    const [deposit, withdrawal, transfer] = appended;
    if (deposit === undefined || withdrawal === undefined || transfer === undefined) {
      throw new Error('append returned fewer results than transactions');
    }

    expect(await storedKind(deposit.transactionId)).toBe('deposit');
    expect(await storedKind(withdrawal.transactionId)).toBe('withdrawal');
    expect(await storedKind(transfer.transactionId)).toBe('transfer');
    expect(await storedEntries(deposit.transactionId)).toEqual([
      [a1.id, '500'],
      [s.id, '-500'],
    ]);
    expect(await storedEntries(withdrawal.transactionId)).toEqual([
      [a1.id, '-200'],
      [s.id, '200'],
    ]);
    expect(await storedEntries(transfer.transactionId)).toEqual([
      [a1.id, '-300'],
      [b1.id, '300'],
    ]);
    expect([...deposit.balances]).toEqual([[a1.id, 1500n]]);
    expect([...withdrawal.balances]).toEqual([[a1.id, 1300n]]);
    expect([...transfer.balances].sort()).toEqual(
      [
        [a1.id, 1000n],
        [b1.id, 300n],
      ].sort(),
    );
    expect(deposit.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    expect(await balanceOf(a1.id)).toBe('1000');
    expect(await balanceOf(b1.id)).toBe('300');
    expect(await rowVersion(s.id)).toEqual(before);
    expect(before.balance).toBeNull();
  });

  it('LED-R18 gives each entry a created_at taken at its insert, after the start of the database transaction', async () => {
    const a1 = await customer();
    const s = await settlement();
    const { start, transactionId } = await unitOfWork.run(
      async (uow) => {
        // now() is the start of the database transaction; the entries come 50 ms later.
        const now = await sql<{ now: string }>`SELECT now()::text AS now`.execute(uow.db);
        await sql`SELECT pg_sleep(0.05)`.execute(uow.db);
        const result = await new KyselyLedgerWriter(uow, ids).append(
          LedgerTransaction.deposit(a1, s, 100n),
        );
        await new KyselyAuditLog(uow.db, ids).record({
          actorId: TEST_OPERATOR_ID,
          actorRole: 'operator',
          action: 'deposit',
          accountIds: [a1.id],
          transactionId: result.transactionId,
          requestId: 'test-ledger-writer',
        });
        return { start: now.rows[0]?.now, transactionId: result.transactionId };
      },
      { retry: 'none' },
    );
    const result = await runtimePool().query<{ after: boolean; entries: string }>(
      `SELECT bool_and(created_at >= $2::timestamptz + interval '50 milliseconds') AS after,
              count(*)::text AS entries
       FROM ledger_entries WHERE transaction_id = $1`,
      [transactionId, start],
    );
    expect(result.rows[0]).toEqual({ after: true, entries: '2' });
  });

  it('SYS-R11 reports the end of the entries and of the balance changes to the unit of work, whose fault leaves nothing behind', async () => {
    const a1 = await customer('1000');
    const s = await settlement();
    const reached: FaultStep[] = [];
    const fault = new Error('fault after the balance changes');
    const faulty = new UnitOfWorkRunner(new TransactionRunner({ pool: runtimePool() }), {
      faults: {
        atStep(step) {
          reached.push(step);
          if (step === 'after-balances') throw fault;
        },
      },
    });
    let transactionId: string | undefined;
    await expect(
      faulty.run(
        async (uow) => {
          const writer = new KyselyLedgerWriter(uow, {
            next: () => {
              const id = ids.next();
              transactionId ??= id;
              return id;
            },
          });
          await writer.append(LedgerTransaction.withdrawal(a1, s, 400n));
        },
        { retry: 'none' },
      ),
    ).rejects.toBe(fault);
    expect(reached).toEqual(['after-entries', 'after-balances']);
    expect(transactionId).toBeDefined();
    expect(await storedKind(transactionId ?? '')).toBeUndefined();
    expect(await balanceOf(a1.id)).toBe('1000');
  });
});
