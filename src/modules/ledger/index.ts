// The ledger module's public API (plan 000 section 2): domain types, errors, use cases and ports.
// The composition root imports the adapters directly, so no other module loads Kysely through here.
export { CURRENCIES, findCurrency, type Currency, type CurrencyCode } from './domain/currency.js';
export {
  AmountOutOfRange,
  BalanceLimitExceeded,
  EntryCurrencyMismatch,
  InvalidAmountType,
  MixedCurrencies,
  TooFewEntries,
  TransactionCurrencyMismatch,
  Unbalanced,
  ZeroAmount,
} from './domain/errors.js';
export {
  LedgerTransaction,
  type AccountKind,
  type AccountRef,
  type BalanceChange,
  type LedgerEntry,
  type LedgerEntryInput,
  type TransactionKind,
} from './domain/ledger-transaction.js';
export { credit, debit, MAX_MINOR_UNITS, toAmount, type Amount } from './domain/money.js';
export { reconcile, type ReconciliationReport } from './application/reconciliation.js';
export type {
  AppendedTransaction,
  BalanceQueries,
  CurrencyTotal,
  Discrepancy,
  LedgerWriter,
  ReconciliationQuery,
} from './application/ports.js';
