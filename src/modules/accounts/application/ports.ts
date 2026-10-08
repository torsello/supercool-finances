import type { CurrencyCode } from '../../ledger/index.js';
import type { Account, AccountStatus, StatusAction } from '../domain/account.js';
import type { Position } from './keyset.js';

/** A customer account as stored, timestamps at microseconds (plan 001 section 5). */
export interface AccountRecord {
  id: string;
  ownerId: string;
  currency: CurrencyCode;
  status: AccountStatus;
  balance: bigint;
  createdAt: string;
  updatedAt: string;
}

export type HistoryEntryKind = 'deposit' | 'withdrawal' | 'transfer' | 'reversal';

/** One ledger entry of an account's history (section 1.4 of spec 001). */
export interface HistoryEntryRecord {
  id: string;
  transactionId: string;
  kind: HistoryEntryKind;
  /** Signed minor units: positive adds to the balance, negative subtracts from it. */
  amount: bigint;
  currency: CurrencyCode;
  createdAt: string;
}

/** Writes customer accounts; every method acts on customer accounts only, never a system one. */
export interface AccountRepository {
  insert(account: Account): Promise<AccountRecord>;
  /** `SELECT ... FOR UPDATE` on a customer account; `undefined` when there is none (plan 001 section 3.5). */
  lockForStatusChange(id: string): Promise<AccountRecord | undefined>;
  /** Sets the status and `updated_at` to the database clock. */
  updateStatus(id: string, status: AccountStatus): Promise<AccountRecord>;
}

/** Reads for the query services; customer accounts and their entries only (ACC-R25). */
export interface AccountQueries {
  /** The customer account `id`, restricted to `ownerId` when one is given. */
  findCustomerAccount(id: string, ownerId?: string): Promise<AccountRecord | undefined>;
  /** Up to `limit` of the owner's accounts, newest first, strictly after `after` (plan 001 section 3.3). */
  listOwned(ownerId: string, limit: number, after?: Position): Promise<AccountRecord[]>;
  /** Up to `limit` entries of the account, newest first, strictly after `after` (plan 001 section 3.4). */
  listEntries(accountId: string, limit: number, after?: Position): Promise<HistoryEntryRecord[]>;
}

/** The audit record of a status change (ACC-R26). */
export interface StatusChangeAuditRecord {
  actorId: string;
  actorRole: 'operator';
  action: StatusAction;
  accountIds: readonly string[];
  oldStatus: AccountStatus;
  newStatus: AccountStatus;
  requestId: string;
}

export interface AuditLog {
  record(record: StatusChangeAuditRecord): Promise<void>;
}

export interface IdGenerator {
  next(): string;
}

/** What a status change uses inside its database transaction. */
export interface StatusChangeTransaction {
  /** Bounds the next lock waits of this transaction (ACC-R28). */
  setLockTimeout(ms: number): Promise<void>;
  accounts: AccountRepository;
  audit: AuditLog;
}

/** Runs work in one database transaction that is never retried (plan 000 section 6.1). */
export interface AccountTransactions {
  run<T>(work: (tx: StatusChangeTransaction) => Promise<T>): Promise<T>;
}

/** The authenticated caller of a read (AUT-R07). */
export interface Viewer {
  userId: string;
  role: 'customer' | 'operator';
}
