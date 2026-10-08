/**
 * Business rejections of a movement (plan 003 section 5). `AccountNotActive` and `NotFound` come
 * from the accounts module, `BalanceLimitExceeded` from the ledger module.
 */

/**
 * The request currency differs from the path account's, or an own destination's from the
 * source's (MOV-R11, MOV-R14): 422 `/problems/currency-mismatch`.
 */
export class CurrencyMismatch extends Error {
  override readonly name = 'CurrencyMismatch';

  constructor() {
    super('the currency does not match the account');
  }
}

/** The amount is above the debited account's balance (MOV-R16): 422 `/problems/insufficient-funds`. */
export class InsufficientFunds extends Error {
  override readonly name = 'InsufficientFunds';

  constructor() {
    super('the balance does not cover the amount');
  }
}

/**
 * Every condition of MOV-R15, with one fixed message whatever the condition, so the answer never
 * tells which one held (SYS-R41): 422 `/problems/destination-unavailable`.
 */
export class DestinationUnavailable extends Error {
  override readonly name = 'DestinationUnavailable';

  constructor() {
    super('the destination cannot receive this transfer');
  }
}

/**
 * A reversal would debit a customer account by more than its balance (REV-R08): 422
 * `/problems/insufficient-funds-for-reversal`.
 */
export class InsufficientFundsForReversal extends Error {
  override readonly name = 'InsufficientFundsForReversal';

  constructor() {
    super('the balance does not cover the reversal');
  }
}
