import pg from 'pg';
import {
  AccountLockTimeout,
  IdempotencyWaitTimeout,
  LedgerWriteRejected,
  ProxyBorrowTimeout,
  StatementTimeout,
} from './errors.js';

/**
 * Where a statement ran in the movement skeleton (plan 000 section 6.2): `key-wait` for the key
 * steps 3, 3b, 3c and their re-passes, `work` for every statement after them, `COMMIT` included.
 */
export type DatabaseStep = 'key-wait' | 'work';

const RETRYABLE = new Set(['40P01', '40001']);

/** The constraints of the ledger checks of spec 002 (migrations `accounts` and `ledger`). */
const LEDGER_CONSTRAINTS = new Set([
  'ledger_transaction_min_entries',
  'ledger_transaction_one_currency',
  'ledger_transaction_balanced',
  'ledger_transaction_written_once',
  'ledger_entries_amount_not_zero',
  'ledger_entries_transaction_id_currency_fkey',
  'ledger_entries_account_id_currency_fkey',
  'transactions_reversed_transaction_id_fkey',
  'transactions_reversal_link',
  'transactions_kind_check',
  'transactions_currency_check',
  'accounts_balance_check',
  'accounts_kind_columns',
]);
const LEDGER_TABLES = new Set(['transactions', 'ledger_entries']);
/** The context PostgreSQL gives the append-only trigger's exception (LED-R16). */
const APPEND_ONLY_TRIGGER = 'function ledger_refuse_change()';

/**
 * The SQLSTATE of a database error, also when a typed error holds it as its `cause`, so the line
 * that logs a failed request names it (SYS-R22); undefined for any other error.
 */
export function sqlstateOf(error: unknown): string | undefined {
  if (error instanceof pg.DatabaseError) return error.code;
  return error instanceof Error ? sqlstateOf(error.cause) : undefined;
}

/** RDS Proxy's answer when its `connection_borrow_timeout` runs out (SEC-R49). */
const PROXY_BORROW_TIMEOUT = '08000';

/**
 * Whether a statement failed with RDS Proxy's borrow timeout, after which its connection is never
 * used again: it is destroyed on release, without a ROLLBACK (SEC-R49).
 */
export function isProxyBorrowTimeout(error: unknown): boolean {
  return sqlstateOf(error) === PROXY_BORROW_TIMEOUT;
}

/** `pg`'s errors for a statement whose connection closed, or that a broken client refused. */
const CONNECTION_LOST_MESSAGES = new Set([
  'Connection terminated unexpectedly',
  'Connection terminated',
  'Client has encountered a connection error and is not queryable',
]);

/** The socket errors Node raises when the connection to the server breaks. */
const CONNECTION_LOST_CODES = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT']);

/**
 * SQLSTATEs of a session the server ended: 57P01 (terminated by an administrator or a shutdown),
 * 57P02 (crash shutdown), 57P03 (the server cannot accept connections now).
 */
const SESSION_ENDED = new Set(['57P01', '57P02', '57P03']);

/**
 * Whether a statement failed because its database connection was lost (SEC-R57): `pg`'s own
 * connection error, which is not a `DatabaseError`, a socket error, or a session the server ended.
 */
export function isConnectionLoss(error: unknown): boolean {
  if (error instanceof pg.DatabaseError) return SESSION_ENDED.has(error.code ?? '');
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return (
    CONNECTION_LOST_MESSAGES.has(error.message) ||
    (code !== undefined && CONNECTION_LOST_CODES.has(code))
  );
}

/** A deadlock or serialization failure, which the runner retries for movements (SYS-R18). */
export function isRetryable(error: unknown): boolean {
  return error instanceof pg.DatabaseError && RETRYABLE.has(error.code ?? '');
}

function isLedgerCheck(error: pg.DatabaseError): boolean {
  switch (error.code) {
    case '23502':
      return LEDGER_TABLES.has(error.table ?? '');
    case '23503':
    case '23514':
      return LEDGER_CONSTRAINTS.has(error.constraint ?? '');
    case 'P0001':
      return error.where?.includes(APPEND_ONLY_TRIGGER) === true;
    default:
      return false;
  }
}

/**
 * Turns a `pg` error into the typed error of plan 000 section 6.3, by the step it was raised at.
 * Anything else is returned as it is: retryable errors for the runner, the 23505 of a second
 * reversal for the ledger adapter, and every other error, answered 500.
 */
export function classifyDatabaseError(error: unknown, step: DatabaseStep): unknown {
  if (!(error instanceof pg.DatabaseError)) return error;
  if (error.code === '55P03') {
    return step === 'key-wait'
      ? new IdempotencyWaitTimeout({ cause: error })
      : new AccountLockTimeout({ cause: error });
  }
  if (error.code === '57014') return new StatementTimeout({ cause: error });
  if (error.code === PROXY_BORROW_TIMEOUT) return new ProxyBorrowTimeout({ cause: error });
  if (error.code !== undefined && isLedgerCheck(error)) {
    return new LedgerWriteRejected(error.code, error.constraint, { cause: error });
  }
  return error;
}
