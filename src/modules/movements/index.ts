// The movements module's public API (plan 000 section 2): domain types, errors, use cases and
// ports. The composition root imports the adapters directly.
export {
  CurrencyMismatch,
  DestinationUnavailable,
  InsufficientFunds,
  InsufficientFundsForReversal,
} from './domain/errors.js';
export { planLocks } from './domain/lock-plan.js';
export {
  checkReversal,
  type ReversalAccount,
  type ReversalState,
} from './domain/reversal-rules.js';
export {
  depositTransaction,
  transferTransaction,
  withdrawalTransaction,
  type Destination,
  type SettlementRef,
} from './domain/movement-rules.js';
export { deposit, type DepositCommand } from './application/deposit.js';
export { withdraw, type WithdrawCommand } from './application/withdraw.js';
export { transfer, type TransferCommand } from './application/transfer.js';
export {
  Reversals,
  type ReversalsOptions,
  type ReversalTestHook,
  type ReverseCommand,
  type SkipExistingReversalCheck,
} from './application/reverse.js';
export { getTransaction, type TransactionView } from './application/get-transaction.js';
export type {
  AccountMovementResult,
  MovementResult,
  ReversalResult,
} from './application/results.js';
export type {
  AccountLookup,
  AccountWithSettlement,
  AuditLog,
  IdGenerator,
  LockedAccount,
  MovementAccounts,
  MovementAuditRecord,
  MovementSettings,
  MovementTransaction,
  MovementTransactions,
  StoredTransaction,
  TransactionLookup,
  TransactionQueries,
} from './application/ports.js';
