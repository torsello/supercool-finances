import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { NotFound } from '../../../src/modules/accounts/index.js';
import {
  AlreadyReversed,
  TransactionNotReversible,
  type AlreadyReversedCause,
} from '../../../src/modules/ledger/index.js';
import {
  deposit,
  Reversals,
  transfer,
  withdraw,
  type ReversalsOptions,
} from '../../../src/modules/movements/index.js';
import {
  balanceOf,
  closePools,
  createCustomerAccount,
  runtimePool,
  settlementAccountId,
} from '../../support/db.js';
import { openLockSession } from '../../support/sessions.js';
import {
  C1,
  C2,
  customer,
  entriesOf,
  movementTransactions,
  OPERATOR,
  settings,
  settlementSum,
  writtenRows,
} from '../movements/support.js';

const REASON = 'Duplicate deposit from rail';

interface ReversalAudit {
  actor_id: string;
  actor_role: string;
  action: string;
  account_ids: string[];
  reversed_transaction_id: string | null;
  reason: string | null;
  request_id: string;
}

async function auditsOf(transactionId: string): Promise<ReversalAudit[]> {
  const result = await runtimePool().query<ReversalAudit>(
    `SELECT actor_id, actor_role, action, account_ids::text[] AS account_ids,
            reversed_transaction_id, reason, request_id
     FROM audit_records WHERE transaction_id = $1`,
    [transactionId],
  );
  return result.rows;
}

/** Every column of a transaction and of its entries, to prove a reversal changes none. */
async function storedRows(transactionId: string): Promise<unknown[]> {
  const result = await runtimePool().query<Record<string, unknown>>(
    `SELECT t.*, e.id AS entry_id, e.account_id, e.amount, e.currency AS entry_currency,
            e.created_at AS entry_created_at
     FROM transactions t JOIN ledger_entries e ON e.transaction_id = t.id
     WHERE t.id = $1 ORDER BY e.id`,
    [transactionId],
  );
  return result.rows;
}

async function reversalsOf(transactionId: string): Promise<string[]> {
  const result = await runtimePool().query<{ id: string }>(
    'SELECT id FROM transactions WHERE reversed_transaction_id = $1',
    [transactionId],
  );
  return result.rows.map((row) => row.id);
}

describe('reverse use case', () => {
  const movements = movementTransactions();

  afterAll(async () => {
    await closePools();
  });

  /** As the production composition root builds it: no test hook. */
  const reversals = new Reversals();

  function reverseTransaction(transactionId: string, component: Reversals = reversals) {
    return movements.run(
      async (tx) =>
        await component.reverse(tx, settings, {
          transactionId,
          reason: REASON,
          actor: OPERATOR,
          requestId: 'req-reverse',
        }),
    );
  }

  async function depositInto(accountId: string, amount: bigint): Promise<string> {
    const result = await movements.run(
      async (tx) =>
        await deposit(tx, settings, {
          accountId,
          amount,
          currency: 'EUR',
          actor: OPERATOR,
          requestId: 'req-deposit',
        }),
    );
    return result.transactionId;
  }

  it('REV-R01 REV-R02 REV-R15 reversing a deposit, a withdrawal and a transfer appends the negated entries, changes the balances, keeps the originals and writes one audit record with the reason', async () => {
    const s = await settlementAccountId('EUR');
    const a1 = (await createCustomerAccount({ currency: 'EUR', ownerId: C1 })).id;
    const b1 = (await createCustomerAccount({ currency: 'EUR', ownerId: C2 })).id;
    const d = await depositInto(a1, 5000n);
    const w = await movements.run(
      async (tx) =>
        await withdraw(tx, settings, {
          accountId: a1,
          amount: 1200n,
          currency: 'EUR',
          actor: customer(C1),
          requestId: 'req-withdraw',
        }),
    );
    const t = await movements.run(
      async (tx) =>
        await transfer(tx, settings, {
          accountId: a1,
          destinationAccountId: b1,
          amount: 300n,
          currency: 'EUR',
          actor: customer(C1),
          requestId: 'req-transfer',
        }),
    );
    expect([await balanceOf(a1), await balanceOf(b1)]).toEqual(['3500', '300']);
    const originals = [d, w.transactionId, t.transactionId];
    const before = await Promise.all(originals.map(storedRows));
    const settlementBefore = await settlementSum(s);

    const ofW = await reverseTransaction(w.transactionId);
    expect(ofW).toEqual({
      transactionId: expect.any(String) as string,
      kind: 'reversal',
      amount: 1200n,
      currency: 'EUR',
      createdAt: expect.stringMatching(/\.\d{6}Z$/) as string,
      reversedTransactionId: w.transactionId,
    });
    expect(await entriesOf(ofW.transactionId)).toEqual([
      [a1, '1200'],
      [s, '-1200'],
    ]);
    expect(await balanceOf(a1)).toBe('4700');

    // Given in uppercase, as a path may carry it.
    const ofT = await reverseTransaction(t.transactionId.toUpperCase());
    expect(ofT).toMatchObject({ amount: 300n, reversedTransactionId: t.transactionId });
    expect(await entriesOf(ofT.transactionId)).toEqual([
      [a1, '300'],
      [b1, '-300'],
    ]);
    expect([await balanceOf(a1), await balanceOf(b1)]).toEqual(['5000', '0']);

    const ofD = await reverseTransaction(d);
    expect(ofD).toMatchObject({ kind: 'reversal', amount: 5000n, reversedTransactionId: d });
    expect(await entriesOf(ofD.transactionId)).toEqual([
      [a1, '-5000'],
      [s, '5000'],
    ]);
    expect([await balanceOf(a1), await balanceOf(b1)]).toEqual(['0', '0']);
    // S got −1200 back from W's reversal and +5000 from D's.
    expect((await settlementSum(s)) - settlementBefore).toBe(3800n);

    expect(await Promise.all(originals.map(storedRows))).toEqual(before);
    const audit = (accountIds: string[], reversedTransactionId: string) => [
      {
        actor_id: OPERATOR.id,
        actor_role: 'operator',
        action: 'reversal',
        account_ids: accountIds.toSorted(),
        reversed_transaction_id: reversedTransactionId,
        reason: REASON,
        request_id: 'req-reverse',
      },
    ];
    expect(await auditsOf(ofW.transactionId)).toEqual(audit([a1], w.transactionId));
    expect(await auditsOf(ofT.transactionId)).toEqual(audit([a1, b1], t.transactionId));
    expect(await auditsOf(ofD.transactionId)).toEqual(audit([a1], d));
  });

  it('REV-R18 never locks or updates the settlement row: with it held FOR NO KEY UPDATE, reversals that credit and debit it complete', async () => {
    const s = await settlementAccountId('EUR');
    const a1 = (await createCustomerAccount({ currency: 'EUR', ownerId: C1 })).id;
    const d = await depositInto(a1, 700n);
    const w = await movements.run(
      async (tx) =>
        await withdraw(tx, settings, {
          accountId: a1,
          amount: 200n,
          currency: 'EUR',
          actor: customer(C1),
          requestId: 'req-withdraw',
        }),
    );
    const session = await openLockSession();
    try {
      await session.lockRow('accounts', s, 'FOR NO KEY UPDATE');
      await reverseTransaction(w.transactionId);
      await reverseTransaction(d);
    } finally {
      await session.close();
    }
    expect(await balanceOf(a1)).toBe('0');
  });

  it('REV-R01 REV-R07 an unknown id, an id that is not a UUID and an account id are not found, and a reversal is not reversible, with nothing written', async () => {
    const a1 = (await createCustomerAccount({ currency: 'EUR', ownerId: C1 })).id;
    const d = await depositInto(a1, 1000n);
    const r = (await reverseTransaction(d)).transactionId;
    const before = await writtenRows();

    for (const id of [randomUUID(), 'not-a-uuid', a1]) {
      await expect(reverseTransaction(id)).rejects.toBeInstanceOf(NotFound);
    }
    await expect(reverseTransaction(r)).rejects.toBeInstanceOf(TransactionNotReversible);

    expect(await writtenRows()).toEqual(before);
    expect(await reversalsOf(r)).toEqual([]);
    expect(await balanceOf(a1)).toBe('0');
  });

  it('REV-R06 a second reversal found by the check is AlreadyReversed, with nothing written', async () => {
    const a1 = (await createCustomerAccount({ currency: 'EUR', ownerId: C1 })).id;
    const d = await depositInto(a1, 1000n);
    const first = await reverseTransaction(d);
    await depositInto(a1, 1000n);
    const before = await writtenRows();

    const refused = await reverseTransaction(d).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AlreadyReversed);
    expect((refused as AlreadyReversed).cause).toBeUndefined();

    expect(await writtenRows()).toEqual(before);
    expect(await reversalsOf(d)).toEqual([first.transactionId]);
    expect(await balanceOf(a1)).toBe('1000');
  });

  it('REV-R05 REV-R06 SYS-R37 with the existing-reversal check skipped through the component built with the seam, the unique constraint refuses the insert and the use case ends with AlreadyReversed, not an internal error', async () => {
    const a1 = (await createCustomerAccount({ currency: 'EUR', ownerId: C1 })).id;
    const d = await depositInto(a1, 1000n);
    await depositInto(a1, 1000n);
    const first = await reverseTransaction(d);
    expect(await balanceOf(a1)).toBe('1000');
    const before = await writtenRows();

    const record: { skipped: string[]; refused: (AlreadyReversedCause | undefined)[] } = {
      skipped: [],
      refused: [],
    };
    const options: ReversalsOptions = {
      skipExistingReversalCheck: {
        skips: (id) => {
          record.skipped.push(id);
          return true;
        },
        insertRefused: (cause) => record.refused.push(cause),
      },
    };
    const withSeam = new Reversals(options);
    expect(reversals.attachedTestHooks()).toEqual([]);
    expect(withSeam.attachedTestHooks()).toEqual(['skip-existing-reversal-check']);

    const refused = reverseTransaction(d, withSeam);
    await expect(refused).rejects.toBeInstanceOf(AlreadyReversed);
    await expect(refused).rejects.toHaveProperty('cause', {
      sqlstate: '23505',
      constraint: 'transactions_reversed_transaction_id_key',
    });

    expect(record).toEqual({
      skipped: [d],
      refused: [{ sqlstate: '23505', constraint: 'transactions_reversed_transaction_id_key' }],
    });
    expect(await writtenRows()).toEqual(before);
    expect(await reversalsOf(d)).toEqual([first.transactionId]);
    expect(await balanceOf(a1)).toBe('1000');
  });
  it('SYS-R37 a hook that answers false for a transaction leaves the existing-reversal check in place, so the check refuses the second reversal and the hook records no refused insert', async () => {
    const a1 = (await createCustomerAccount({ currency: 'EUR', ownerId: C1 })).id;
    const d = await depositInto(a1, 1000n);
    await depositInto(a1, 1000n);
    await reverseTransaction(d);
    const before = await writtenRows();

    const asked: string[] = [];
    const refused: (AlreadyReversedCause | undefined)[] = [];
    const inactive = new Reversals({
      skipExistingReversalCheck: {
        skips: (id) => {
          asked.push(id);
          return false;
        },
        insertRefused: (cause) => refused.push(cause),
      },
    });

    const second: unknown = await reverseTransaction(d, inactive).catch((error: unknown) => error);
    expect(second).toBeInstanceOf(AlreadyReversed);
    // Raised by the check, not mapped from a refused insert, so it has no cause.
    expect((second as AlreadyReversed).cause).toBeUndefined();
    expect(asked).toEqual([d]);
    expect(refused).toEqual([]);
    expect(await writtenRows()).toEqual(before);
  });
});
