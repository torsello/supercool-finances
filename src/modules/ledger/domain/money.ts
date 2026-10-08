import { AmountOutOfRange, BalanceLimitExceeded, InvalidAmountType } from './errors.js';

/** The PostgreSQL `bigint` maximum: the largest amount and cached balance (SYS-R07, LED-R26). */
export const MAX_MINOR_UNITS = 9223372036854775807n;

declare const amountBrand: unique symbol;

/** A movement amount: a `bigint` from 1 to 9223372036854775807 minor units, built by `toAmount`. */
export type Amount = bigint & { readonly [amountBrand]: true };

function requireBigints(...values: unknown[]): void {
  if (values.some((value) => typeof value !== 'bigint')) throw new InvalidAmountType();
}

/** The amount `value`, refused when it is not a `bigint` or outside 1 to the maximum (SYS-R07). */
export function toAmount(value: bigint): Amount {
  requireBigints(value);
  if (value < 1n || value > MAX_MINOR_UNITS) throw new AmountOutOfRange();
  return value as Amount;
}

/** `balance + amount`, refused above the limit (LED-R26, LED-R27). */
export function credit(balance: bigint, amount: Amount): bigint {
  requireBigints(balance);
  // Checked again, so an amount cast past toAmount still never reaches the arithmetic.
  toAmount(amount);
  const result = balance + amount;
  if (result > MAX_MINOR_UNITS) throw new BalanceLimitExceeded();
  return result;
}

/** `balance − amount`; the use cases check funds before calling it (plan 002 section 3). */
export function debit(balance: bigint, amount: Amount): bigint {
  requireBigints(balance);
  toAmount(amount);
  return balance - amount;
}
