/**
 * Typed errors for database failures that are not business rejections (plan 000 sections 6.3 and
 * 7). Their messages are fixed: the driver's error stays in `cause`, for the log only, and never
 * reaches a response (SYS-R24).
 */

/** A deadlock or serialization failure still present after the last attempt (SYS-R19). */
export class RetriesExhausted extends Error {
  override readonly name = 'RetriesExhausted';

  constructor(
    readonly attempts: number,
    options: { cause: unknown },
  ) {
    super('database transaction still failed after its last attempt', options);
  }
}

/** A customer account's row lock not acquired within the account lock timeout (MOV-R20, ACC-R29). */
export class AccountLockTimeout extends Error {
  override readonly name = 'AccountLockTimeout';

  constructor(options: { cause: unknown }) {
    super('account row lock not acquired in time', options);
  }
}

/**
 * An idempotency key held by another request beyond the idempotency wait timeout (IDM-R12): a
 * 55P03 at a key-wait step, or no time left before the key-wait deadline, with no cause.
 */
export class IdempotencyWaitTimeout extends Error {
  override readonly name = 'IdempotencyWaitTimeout';

  constructor(options?: { cause: unknown }) {
    super('idempotency key still held by another request', options);
  }
}

/** A statement cancelled by `statement_timeout`, SQLSTATE 57014 (SEC-R32). */
export class StatementTimeout extends Error {
  override readonly name = 'StatementTimeout';

  constructor(options: { cause: unknown }) {
    super('statement cancelled by statement_timeout', options);
  }
}

/**
 * The database refused a ledger write through one of the checks of spec 002: the domain missed a
 * rule, a defect answered 500 and logged with its SQLSTATE and constraint (LED-R28).
 */
export class LedgerWriteRejected extends Error {
  override readonly name = 'LedgerWriteRejected';

  constructor(
    readonly sqlstate: string,
    readonly constraint: string | undefined,
    options: { cause: unknown },
  ) {
    super('the database refused a ledger write', options);
  }
}

/**
 * No pool connection became free within `DB_POOL_ACQUIRE_TIMEOUT_MS` (SEC-R37): 503, and nothing
 * was written, since no statement was sent.
 */
export class PoolAcquireTimeout extends Error {
  override readonly name = 'PoolAcquireTimeout';

  constructor(options: { cause: unknown }) {
    super('no database connection became free in time', options);
  }
}

/**
 * SQLSTATE 08000, which RDS Proxy answers when it finds no database connection for a statement
 * within its `connection_borrow_timeout` (SEC-R49): 503 like an exhausted pool, and the connection
 * is destroyed, never used again, not even for ROLLBACK.
 */
export class ProxyBorrowTimeout extends Error {
  override readonly name = 'ProxyBorrowTimeout';

  constructor(options: { cause: unknown }) {
    super('the database proxy found no connection in time', options);
  }
}

/**
 * The request pool was already closed by the shutdown (SEC-R27): a transient condition, 503 like
 * an exhausted pool, never 500 (SYS-R34).
 */
export class PoolClosed extends Error {
  override readonly name = 'PoolClosed';

  constructor(options: { cause: unknown }) {
    super('the database pool is closed', options);
  }
}

/**
 * The database connection was lost while a request used it (SEC-R57): `pg`'s connection error, or
 * a session the server terminated. Before `COMMIT` the transaction rolled back; during `COMMIT` its
 * outcome is unknown. Either way 503, never 500, so the client retries with the same
 * Idempotency-Key and gets the stored response or a new run. The connection is destroyed.
 */
export class ConnectionLost extends Error {
  override readonly name = 'ConnectionLost';

  constructor(options: { cause: unknown }) {
    super('the database connection was lost during the request', options);
  }
}
