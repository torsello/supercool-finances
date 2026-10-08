// The movements module's public API (plan 000 section 2): domain types, errors, use cases and
// ports. The composition root imports the adapters directly.
export { CurrencyMismatch, DestinationUnavailable, InsufficientFunds } from './domain/errors.js';
export { planLocks } from './domain/lock-plan.js';
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
export { getTransaction, type TransactionView } from './application/get-transaction.js';
export type { AccountMovementResult, MovementResult } from './application/results.js';
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
  TransactionQueries,
} from './application/ports.js';
