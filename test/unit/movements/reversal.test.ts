import { describe, expect, it } from 'vitest';
import {
  LedgerTransaction,
  reversalOf,
  TransactionNotReversible,
  type RecordedTransaction,
} from '../../../src/modules/ledger/index.js';

const A1 = {
  id: '0192f0c4-0000-7000-8000-0000000000a1',
  kind: 'customer',
  currency: 'EUR',
} as const;
const B1 = {
  id: '0192f0c4-0000-7000-8000-0000000000b1',
  kind: 'customer',
  currency: 'EUR',
} as const;
const S = { id: '0192f0c4-0000-7000-8000-0000000000e0', kind: 'system', currency: 'EUR' } as const;

const D_ID = '0192f0c4-0000-7000-8000-0000000000d1';
const W_ID = '0192f0c4-0000-7000-8000-0000000000d2';
const T_ID = '0192f0c4-0000-7000-8000-0000000000d3';
const R_ID = '0192f0c4-0000-7000-8000-0000000000d4';

/** A domain transaction as the ledger recorded it, under the id it was written with. */
function recorded(id: string, transaction: LedgerTransaction): RecordedTransaction {
  return {
    id,
    kind: transaction.kind,
    currency: transaction.currency,
    entries: transaction.entries,
  };
}

/** Everything a transaction holds, as plain data, to compare before and after a call. */
function snapshot(transaction: LedgerTransaction) {
  return {
    kind: transaction.kind,
    currency: transaction.currency,
    reversedTransactionId: transaction.reversedTransactionId,
    entries: transaction.entries.map((entry) => ({ ...entry })),
  };
}

function shape(transaction: LedgerTransaction) {
  return {
    kind: transaction.kind,
    currency: transaction.currency,
    reversedTransactionId: transaction.reversedTransactionId,
    entries: transaction.entries.map((entry) => [entry.accountId, entry.amount]),
  };
}

describe('reversalOf', () => {
  it('REV-AC03 builds each reversal as the negation of its original on the same accounts, and refuses to reverse a reversal', () => {
    const d = LedgerTransaction.deposit(A1, S, 1050n);
    const w = LedgerTransaction.withdrawal(A1, S, 1200n);
    const t = LedgerTransaction.transfer(A1, B1, 300n);
    const before = [snapshot(d), snapshot(w), snapshot(t)];

    const ofD = reversalOf(recorded(D_ID, d));
    const ofW = reversalOf(recorded(W_ID, w));
    const ofT = reversalOf(recorded(T_ID, t));

    expect([shape(ofD), shape(ofW), shape(ofT)]).toEqual([
      {
        kind: 'reversal',
        currency: 'EUR',
        reversedTransactionId: D_ID,
        entries: [
          [A1.id, -1050n],
          [S.id, 1050n],
        ],
      },
      {
        kind: 'reversal',
        currency: 'EUR',
        reversedTransactionId: W_ID,
        entries: [
          [A1.id, 1200n],
          [S.id, -1200n],
        ],
      },
      {
        kind: 'reversal',
        currency: 'EUR',
        reversedTransactionId: T_ID,
        entries: [
          [A1.id, 300n],
          [B1.id, -300n],
        ],
      },
    ]);
    for (const reversal of [ofD, ofW, ofT]) {
      expect(reversal).toBeInstanceOf(LedgerTransaction);
      for (const entry of reversal.entries) expect(typeof entry.amount).toBe('bigint');
    }
    // Each entry keeps its account's kind and currency, so the balance changes skip S.
    expect(ofD.balanceChanges()).toEqual([{ accountId: A1.id, change: -1050n }]);
    expect(ofT.balanceChanges()).toEqual([
      { accountId: A1.id, change: 300n },
      { accountId: B1.id, change: -300n },
    ]);
    expect([snapshot(d), snapshot(w), snapshot(t)]).toEqual(before);

    let returned: LedgerTransaction | undefined;
    expect(() => {
      returned = reversalOf(recorded(R_ID, ofD));
    }).toThrow(TransactionNotReversible);
    expect(returned).toBeUndefined();
  });

  it('REV-R01 only a reversal carries a link, and every reversal has one', () => {
    const entries = LedgerTransaction.deposit(A1, S, 5n).entries;
    expect(LedgerTransaction.deposit(A1, S, 5n).reversedTransactionId).toBeNull();
    expect(() => LedgerTransaction.create({ kind: 'reversal', currency: 'EUR', entries })).toThrow(
      RangeError,
    );
    expect(() =>
      LedgerTransaction.create({
        kind: 'deposit',
        currency: 'EUR',
        entries,
        reversedTransactionId: D_ID,
      }),
    ).toThrow(RangeError);
  });
});
