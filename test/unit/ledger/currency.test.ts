import { describe, expect, expectTypeOf, it } from 'vitest';
import { CURRENCIES, findCurrency, type CurrencyCode } from '../../../src/modules/ledger/index.js';
import type { CurrencyCode as StoredCurrencyCode } from '../../../src/platform/db/schema.js';

describe('currency table', () => {
  it('SYS-AC04 holds exactly USD, MXN, EUR, COP and JPY with exponents 2, 2, 2, 2 and 0, and finds no "GBP" or "eur"', () => {
    expect(CURRENCIES.map(({ code, exponent }) => [code, exponent])).toEqual([
      ['USD', 2],
      ['MXN', 2],
      ['EUR', 2],
      ['COP', 2],
      ['JPY', 0],
    ]);
    expect(findCurrency('GBP')).toBeUndefined();
    expect(findCurrency('eur')).toBeUndefined();
    expect(findCurrency('JPY')).toEqual({ code: 'JPY', exponent: 0 });
  });

  it('SYS-R08 has the same codes as the currency column of the database interface', () => {
    expectTypeOf<CurrencyCode>().toEqualTypeOf<StoredCurrencyCode>();
    expect(CURRENCIES.map(({ code }) => findCurrency(code)?.code)).toEqual(
      CURRENCIES.map(({ code }) => code),
    );
  });
});
