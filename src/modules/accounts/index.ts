// The accounts module's public API (plan 000 section 2): domain types, errors, use cases and
// ports, for the movements module, which applies the status rules (plan 001 section 3.6). The
// composition root imports the adapters directly, so no other module loads Kysely through here.
export {
  Account,
  type AccountState,
  type AccountStatus,
  type StatusAction,
  type StatusDecision,
} from './domain/account.js';
export {
  AccountBalanceNotZero,
  AccountNotActive,
  InvalidStatusTransition,
  NotFound,
} from './domain/errors.js';
export { createAccount, type CreateAccountCommand } from './application/create-account.js';
export {
  changeAccountStatus,
  type ChangeAccountStatusCommand,
} from './application/change-account-status.js';
export {
  listAccounts,
  listHistory,
  readAccount,
  type CustomerAccountView,
  type Page,
  type PageRequest,
} from './application/account-queries.js';
export { compareNewestFirst, isAfter, positionOf, type Position } from './application/keyset.js';
export type {
  AccountQueries,
  AccountRecord,
  AccountRepository,
  AccountTransactions,
  AuditLog,
  HistoryEntryKind,
  HistoryEntryRecord,
  IdGenerator,
  StatusChangeAuditRecord,
  StatusChangeTransaction,
  Viewer,
} from './application/ports.js';
