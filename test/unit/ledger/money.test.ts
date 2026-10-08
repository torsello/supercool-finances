import { describe, expect, it } from 'vitest';
import {
  AmountOutOfRange,
  BalanceLimitExceeded,
  credit,
  debit,
  InvalidAmountType,
  MAX_MINOR_UNITS,
  toAmount,
  type Amount,
} from '../../../src/modules/ledger/index.js';

const MAX = 9223372036854775807n;

describe('balance arithmetic', () => {
  it('LED-AC22 is exact at the bigint limits, refuses a credit above them and refuses a number before any arithmetic', () => {
    expect(credit(9223372036854775806n, toAmount(1n))).toBe(MAX);
    expect(() => credit(MAX, toAmount(1n))).toThrow(BalanceLimitExceeded);
    expect(credit(0n, toAmount(MAX))).toBe(MAX);
    expect(debit(MAX, toAmount(MAX))).toBe(0n);
    // A number reaches the domain only through a defect; the casts stand for that defect.
    expect(() => toAmount(1050 as unknown as bigint)).toThrow(InvalidAmountType);
    expect(() => credit(0n, 1050 as unknown as Amount)).toThrow(InvalidAmountType);
  });

  it('LED-R27 refuses a number as balance or amount of a credit or a debit', () => {
    const number = 1050 as unknown as Amount;
    expect(() => credit(1050 as unknown as bigint, toAmount(1n))).toThrow(InvalidAmountType);
    expect(() => debit(1050 as unknown as bigint, toAmount(1n))).toThrow(InvalidAmountType);
    expect(() => debit(10n, number)).toThrow(InvalidAmountType);
    expect(() => credit(0n, '1050' as unknown as Amount)).toThrow(InvalidAmountType);
  });

  it('LED-R26 has the PostgreSQL bigint maximum as the limit', () => {
    expect(MAX_MINOR_UNITS).toBe(MAX);
  });
});

describe('Amount', () => {
  it('SYS-R07 LED-R27 is a bigint from 1 to 9223372036854775807, refused outside that range', () => {
    expect(toAmount(1n)).toBe(1n);
    expect(toAmount(MAX)).toBe(MAX);
    for (const value of [0n, -1n, -MAX, MAX + 1n]) {
      expect(() => toAmount(value)).toThrow(AmountOutOfRange);
    }
    for (const value of [1, '1', null, undefined]) {
      expect(() => toAmount(value as unknown as bigint)).toThrow(InvalidAmountType);
    }
  });

  it('LED-R26 LED-R27 credit and debit refuse a non-positive or out-of-range amount that bypassed toAmount', () => {
    for (const value of [0n, -1n, MAX + 1n]) {
      const forged = value as Amount;
      expect(() => credit(10n, forged)).toThrow(AmountOutOfRange);
      expect(() => debit(MAX, forged)).toThrow(AmountOutOfRange);
    }
  });
});
