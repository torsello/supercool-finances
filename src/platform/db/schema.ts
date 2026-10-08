import type { ColumnType } from 'kysely';

/**
 * Hand-written Kysely view of the tables in `migrations/`, kept in step with them (plan 000
 * section 2). `int8` and `numeric` values are exact decimal strings (ADR-0010, LED-R27): the domain
 * turns them into `bigint`, never into `number`.
 *
 * Timestamps are never selected as columns: a JavaScript `Date` keeps only milliseconds, and the
 * ledger's order and the cursors need microseconds (plan 001 section 5, ACC-R22, LED-R18). Their
 * select type is `never`; read them with `timestampText` (timestamp.ts), which returns a
 * `TimestampText`. The database sets them; the service only ever writes `clockTimestamp()`.
 *
 * Transactions, ledger entries and audit records are append-only (LED-R16, SYS-R15): none of their
 * columns can be updated, here as in the database.
 */
export interface Database {
  accounts: AccountsTable;
  transactions: TransactionsTable;
  ledger_entries: LedgerEntriesTable;
  audit_records: AuditRecordsTable;
  idempotency_keys: IdempotencyKeysTable;
}

declare const timestampText: unique symbol;
declare const clockTimestamp: unique symbol;

/** An RFC 3339 UTC timestamp with microseconds, `2026-10-08T10:15:30.123456Z`. */
export type TimestampText = string & { readonly [timestampText]: true };

/** The database's `clock_timestamp()`, the only value the service writes to a timestamp. */
export type ClockTimestamp = { readonly [clockTimestamp]: true };

export type CurrencyCode = 'USD' | 'MXN' | 'EUR' | 'COP' | 'JPY';
export type AccountStatus = 'active' | 'frozen' | 'closed';
export type TransactionKind = 'deposit' | 'withdrawal' | 'transfer' | 'reversal';
export type AuditAction = TransactionKind | 'freeze' | 'unfreeze' | 'close';

/** A column that is set on insert and never updated. */
type Immutable<Select, Insert = Select> = ColumnType<Select, Insert, never>;

/** A timestamp set by its column default: never selected directly, never written. */
type DefaultTimestamp = ColumnType<never, never, never>;

/** Customer and system accounts (plan 001 section 2). */
export interface AccountsTable {
  id: Immutable<string>;
  kind: Immutable<'customer' | 'system'>;
  /** `external-settlement:<currency>` for system accounts, null for customer accounts. */
  code: Immutable<string | null, string | null | undefined>;
  owner_id: Immutable<string | null, string | null | undefined>;
  currency: Immutable<CurrencyCode>;
  /** Null for system accounts (LED-R13). */
  status: AccountStatus | null;
  /** Cached balance in minor units; null for system accounts (LED-R13). */
  balance: string | null;
  created_at: DefaultTimestamp;
  /** Set to `clockTimestamp()` after the row lock on every change (plan 001 section 2). */
  updated_at: ColumnType<never, never, ClockTimestamp>;
}

/** One money movement (plan 002 section 2.1, plan 004 section 2). */
export interface TransactionsTable {
  id: Immutable<string>;
  kind: Immutable<TransactionKind>;
  currency: Immutable<CurrencyCode>;
  reversed_transaction_id: Immutable<string | null, string | null | undefined>;
  created_at: DefaultTimestamp;
}

/** Signed entries in minor units, never 0, summing to zero per transaction (plan 002). */
export interface LedgerEntriesTable {
  id: Immutable<string>;
  transaction_id: Immutable<string>;
  account_id: Immutable<string>;
  amount: Immutable<string>;
  currency: Immutable<CurrencyCode>;
  created_at: DefaultTimestamp;
}

/** Audit trail of movements and status changes (plan 000 section 3). */
export interface AuditRecordsTable {
  id: Immutable<string>;
  actor_id: Immutable<string>;
  actor_role: Immutable<'customer' | 'operator'>;
  action: Immutable<AuditAction>;
  account_ids: Immutable<string[]>;
  transaction_id: Immutable<string | null, string | null | undefined>;
  reversed_transaction_id: Immutable<string | null, string | null | undefined>;
  reason: Immutable<string | null, string | null | undefined>;
  old_status: Immutable<AccountStatus | null, AccountStatus | null | undefined>;
  new_status: Immutable<AccountStatus | null, AccountStatus | null | undefined>;
  request_id: Immutable<string>;
  created_at: DefaultTimestamp;
}

/** The stored headers of a key row, as `jsonb` (plan 005 section 2). */
export type StoredHeadersColumn = Record<string, string>;

/**
 * Idempotency keys (plan 005 section 2). The key step's statements write them as SQL text, with
 * `now()` for the timestamps, which are never selected directly; the stored response is null until
 * step 9 completes the row, and a deferred trigger refuses to commit it incomplete (IDM-R18).
 */
export interface IdempotencyKeysTable {
  user_id: Immutable<string>;
  key: Immutable<string>;
  fingerprint: string;
  status: number | null;
  headers: ColumnType<StoredHeadersColumn | null, string | null, string | null>;
  body: Buffer | null;
  created_at: ColumnType<never, never, never>;
  expires_at: ColumnType<never, never, never>;
}
