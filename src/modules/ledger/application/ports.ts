import type { CurrencyCode } from '../domain/currency.js';
import type { LedgerTransaction } from '../domain/ledger-transaction.js';

/** What `append` wrote. */
export interface AppendedTransaction {
  transactionId: string;
  /** RFC 3339 UTC with microseconds (plan 001 section 5). */
  createdAt: string;
  /** The cached balance of each customer account after its change. */
  balances: ReadonlyMap<string, bigint>;
}

/**
 * Appends a transaction, its entries and its balance changes on the unit of work's connection,
 * after the row locks (plan 002 section 4).
 */
export interface LedgerWriter {
  append(transaction: LedgerTransaction): Promise<AppendedTransaction>;
}

export interface BalanceQueries {
  /** The sum of an account's entries as an exact decimal string; it may exceed `bigint` (LED-R15). */
  entriesSum(accountId: string): Promise<string>;
}

/** A customer account whose cached balance differs from the sum of its entries (LED-R19). */
export interface Discrepancy {
  accountId: string;
  currency: CurrencyCode;
  cachedBalance: string;
  entriesSum: string;
  difference: string;
}

/** The global sum of one currency: cached customer balances plus system entries (LED-R19). */
export interface CurrencyTotal {
  currency: CurrencyCode;
  sum: string;
}

/** The statements of the reconciliation, run in one snapshot (plan 002 section 5). */
export interface ReconciliationQuery {
  discrepancies(): Promise<Discrepancy[]>;
  /** One row per currency of table 1.3 of spec 000, in table order. */
  totals(): Promise<CurrencyTotal[]>;
}
