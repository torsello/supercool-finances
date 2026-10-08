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

/** An idempotency key held by another request beyond the idempotency wait timeout (IDM-R12). */
export class IdempotencyWaitTimeout extends Error {
  override readonly name = 'IdempotencyWaitTimeout';

  constructor(options: { cause: unknown }) {
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
