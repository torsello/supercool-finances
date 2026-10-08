/**
 * The supported currencies and their minor-unit exponents: table 1.3 of spec 000 (SYS-R08). The
 * exponent is the power of ten of minor units in one major unit; amounts stay `bigint` minor units.
 */
export const CURRENCIES = Object.freeze([
  Object.freeze({ code: 'USD', exponent: 2 }),
  Object.freeze({ code: 'MXN', exponent: 2 }),
  Object.freeze({ code: 'EUR', exponent: 2 }),
  Object.freeze({ code: 'COP', exponent: 2 }),
  Object.freeze({ code: 'JPY', exponent: 0 }),
] as const);

export type CurrencyCode = (typeof CURRENCIES)[number]['code'];

export interface Currency {
  readonly code: CurrencyCode;
  readonly exponent: number;
}

/** The currency with exactly this code, case included; `undefined` for any other text. */
export function findCurrency(code: string): Currency | undefined {
  return CURRENCIES.find((currency) => currency.code === code);
}
