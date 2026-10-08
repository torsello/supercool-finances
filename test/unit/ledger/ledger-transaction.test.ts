import { describe, expect, it } from 'vitest';
import {
  EntryCurrencyMismatch,
  LedgerTransaction,
  MixedCurrencies,
  TooFewEntries,
  TransactionCurrencyMismatch,
  Unbalanced,
  ZeroAmount,
  type CurrencyCode,
  type LedgerEntryInput,
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
const U1 = {
  id: '0192f0c4-0000-7000-8000-0000000000c1',
  kind: 'customer',
  currency: 'USD',
} as const;
const S = { id: '0192f0c4-0000-7000-8000-0000000000e0', kind: 'system', currency: 'EUR' } as const;
const SU = { id: '0192f0c4-0000-7000-8000-0000000000e1', kind: 'system', currency: 'USD' } as const;

type Ref = typeof A1 | typeof B1 | typeof U1 | typeof S | typeof SU;

function entry(account: Ref, amount: bigint, currency: CurrencyCode = account.currency) {
  return {
    accountId: account.id,
    accountKind: account.kind,
    accountCurrency: account.currency,
    amount,
    currency,
  } satisfies LedgerEntryInput;
}

function shape(transaction: LedgerTransaction) {
  return {
    kind: transaction.kind,
    currency: transaction.currency,
    entries: transaction.entries.map((e) => [e.accountId, e.amount]),
    changes: transaction.balanceChanges().map((c) => [c.accountId, c.change]),
  };
}

describe('LedgerTransaction', () => {
  it('LED-AC01 builds a deposit, a withdrawal and a transfer of the documented shape, with their balance changes', () => {
    const deposit = LedgerTransaction.deposit(A1, S, 1050n);
    const withdrawal = LedgerTransaction.withdrawal(A1, S, 1200n);
    const transfer = LedgerTransaction.transfer(A1, B1, 300n);

    expect(shape(deposit)).toEqual({
      kind: 'deposit',
      currency: 'EUR',
      entries: [
        [A1.id, 1050n],
        [S.id, -1050n],
      ],
      changes: [[A1.id, 1050n]],
    });
    expect(shape(withdrawal)).toEqual({
      kind: 'withdrawal',
      currency: 'EUR',
      entries: [
        [A1.id, -1200n],
        [S.id, 1200n],
      ],
      changes: [[A1.id, -1200n]],
    });
    expect(shape(transfer)).toEqual({
      kind: 'transfer',
      currency: 'EUR',
      entries: [
        [A1.id, -300n],
        [B1.id, 300n],
      ],
      changes: [
        [A1.id, -300n],
        [B1.id, 300n],
      ],
    });
    expect(transfer.entries.some((e) => e.accountKind === 'system')).toBe(false);
    for (const transaction of [deposit, withdrawal, transfer]) {
      for (const e of transaction.entries) expect(typeof e.amount).toBe('bigint');
    }
  });

  it('LED-AC02 refuses malformed transactions with typed errors, in the order of the checks', () => {
    const cases: [CurrencyCode, LedgerEntryInput[], new (...args: never[]) => Error][] = [
      ['EUR', [], TooFewEntries],
      ['EUR', [entry(A1, 100n)], TooFewEntries],
      ['EUR', [entry(A1, 100n), entry(B1, 0n), entry(S, -100n)], ZeroAmount],
      ['EUR', [entry(A1, 100n), entry(S, -99n)], Unbalanced],
      ['EUR', [entry(A1, 100n), entry(SU, -100n)], MixedCurrencies],
      ['USD', [entry(A1, 100n, 'USD'), entry(SU, -100n)], EntryCurrencyMismatch],
      ['EUR', [entry(U1, 100n), entry(SU, -100n)], TransactionCurrencyMismatch],
    ];
    for (const [currency, entries, error] of cases) {
      let built: LedgerTransaction | undefined;
      expect(() => {
        built = LedgerTransaction.create({ kind: 'deposit', currency, entries });
      }).toThrow(error);
      expect(built).toBeUndefined();
    }
  });

  it('LED-R11 sums the entries of one customer account into one balance change, ascending by id', () => {
    const transaction = LedgerTransaction.create({
      kind: 'transfer',
      currency: 'EUR',
      entries: [entry(B1, 300n), entry(A1, -100n), entry(A1, -200n)],
    });
    expect(transaction.balanceChanges()).toEqual([
      { accountId: A1.id, change: -300n },
      { accountId: B1.id, change: 300n },
    ]);
  });

  it('LED-R09 never builds a transfer with a system account, nor a deposit or withdrawal without one', () => {
    expect(() => LedgerTransaction.transfer(A1, S, 100n)).toThrow(RangeError);
    expect(() => LedgerTransaction.transfer(S, A1, 100n)).toThrow(RangeError);
    expect(() => LedgerTransaction.deposit(A1, B1, 100n)).toThrow(RangeError);
    expect(() => LedgerTransaction.withdrawal(S, S, 100n)).toThrow(RangeError);
  });

  it('LED-R27 refuses an amount that is not a positive bigint in the builders', () => {
    expect(() => LedgerTransaction.deposit(A1, S, 0n)).toThrow(RangeError);
    expect(() => LedgerTransaction.withdrawal(A1, S, -5n)).toThrow(RangeError);
    expect(() => LedgerTransaction.transfer(A1, B1, 5 as unknown as bigint)).toThrow();
  });
});
