import type { AccountStatus } from '../../accounts/index.js';
import type {
  CurrencyCode,
  LedgerWriter,
  RecordedTransaction,
  TransactionKind,
} from '../../ledger/index.js';

/** The columns of an account that never change, read without a lock (plan 003 section 3). */
export interface AccountLookup {
  id: string;
  kind: 'customer' | 'system';
  ownerId: string | null;
  currency: CurrencyCode;
}

/** An account with the settlement account of its currency (plan 003 sections 3.1 and 3.2). */
export interface AccountWithSettlement extends AccountLookup {
  settlementId: string;
}

/** What the `FOR UPDATE` statement reads: status and balance, only under the lock (MOV-R22). */
export interface LockedAccount {
  id: string;
  status: AccountStatus;
  balance: bigint;
}

export interface MovementAccounts {
  /** Step 6 of a deposit or withdrawal: one statement, no lock. */
  findWithSettlement(id: string): Promise<AccountWithSettlement | undefined>;
  /** Step 6 of a transfer: the source and the destination, no lock. */
  findAccounts(ids: readonly string[]): Promise<AccountLookup[]>;
  /** Step 7: `FOR UPDATE` on a customer account; a system account gives no row (MOV-R18). */
  lock(id: string): Promise<LockedAccount | undefined>;
}

interface AuditRecordBase {
  actorId: string;
  actorRole: 'customer' | 'operator';
  /** The customer accounts involved; the settlement account follows from the action. */
  accountIds: readonly string[];
  transactionId: string;
  requestId: string;
}

/** The ledger reads of a reversal (plan 004 section 3), without locks. */
export interface TransactionLookup {
  /**
   * Step 6: a transaction with its entries, each with its account's kind and currency, in the
   * order they were written; a transaction and its entries never change.
   */
  findTransaction(id: string): Promise<RecordedTransaction | undefined>;
  /** Step 7, after every lock is held: the id of the transaction's reversal, if it has one. */
  findReversalOf(id: string): Promise<string | undefined>;
}

/** The audit record of a movement (MOV-R24), or of a reversal with its reason (REV-R15). */
export type MovementAuditRecord =
  | (AuditRecordBase & { action: 'deposit' | 'withdrawal' | 'transfer' })
  | (AuditRecordBase & { action: 'reversal'; reversedTransactionId: string; reason: string });

export interface AuditLog {
  record(record: MovementAuditRecord): Promise<void>;
}

export interface IdGenerator {
  next(): string;
}

/** What a movement uses inside its database transaction: steps 6 to 8 of the skeleton. */
export interface MovementTransaction {
  /** Bounds the account lock waits of this transaction (MOV-R19). */
  setLockTimeout(ms: number): Promise<void>;
  accounts: MovementAccounts;
  transactions: TransactionLookup;
  ledger: LedgerWriter;
  audit: AuditLog;
}

/** Runs a movement in one database transaction, retried on 40P01 and 40001 (SYS-R18). */
export interface MovementTransactions {
  run<T>(work: (tx: MovementTransaction) => Promise<T>): Promise<T>;
}

/** A transaction with its entries and the owner of each entry's account (plan 003 section 3.5). */
export interface StoredTransaction {
  id: string;
  kind: TransactionKind;
  currency: CurrencyCode;
  createdAt: string;
  reversedTransactionId: string | null;
  entries: { accountId: string; amount: bigint; ownerId: string | null }[];
}

export interface TransactionQueries {
  findTransaction(id: string): Promise<StoredTransaction | undefined>;
}

/** `ACCOUNT_LOCK_TIMEOUT_MS`, read by the configuration loader (MOV-R31). */
export interface MovementSettings {
  accountLockTimeoutMs: number;
}
