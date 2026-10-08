import type { AccountStatus, StatusAction } from './account.js';

/** Freezing or unfreezing a `closed` account (ACC-R14): 409 `/problems/invalid-status-transition`. */
export class InvalidStatusTransition extends Error {
  override readonly name = 'InvalidStatusTransition';

  constructor(
    readonly status: AccountStatus,
    readonly action: StatusAction,
  ) {
    super('the account status does not allow this change');
  }
}

/** Closing an account whose balance is not 0 (ACC-R16): 409 `/problems/account-balance-not-zero`. */
export class AccountBalanceNotZero extends Error {
  override readonly name = 'AccountBalanceNotZero';

  constructor(
    readonly status: AccountStatus,
    readonly action: StatusAction,
  ) {
    super('the account balance is not zero');
  }
}

/** A movement on a `frozen` or `closed` account (ACC-R19, plan 003): 422 `/problems/account-not-active`. */
export class AccountNotActive extends Error {
  override readonly name = 'AccountNotActive';

  constructor() {
    super('the account is not active');
  }
}

/**
 * An account the caller may not see: unknown, another customer's, a system account, or an id that
 * is not a UUID (ACC-R09, SYS-R38, SYS-R42): 404 `/problems/not-found`, one body for all of them.
 */
export class NotFound extends Error {
  override readonly name = 'NotFound';

  constructor() {
    super('not found');
  }
}
