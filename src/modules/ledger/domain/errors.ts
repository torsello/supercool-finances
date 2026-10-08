/**
 * Typed errors of the ledger domain (plan 002 section 3). The build errors mean a use case built a
 * malformed transaction, a defect answered 500; `BalanceLimitExceeded` is a business rejection.
 */

/** Fewer than two entries (LED-R04). */
export class TooFewEntries extends Error {
  override readonly name = 'TooFewEntries';

  constructor() {
    super('a transaction needs at least two entries');
  }
}

/** An entry of amount 0 (LED-R03). */
export class ZeroAmount extends Error {
  override readonly name = 'ZeroAmount';

  constructor() {
    super('a ledger entry never has amount 0');
  }
}

/** Entries in more than one currency (LED-R07). */
export class MixedCurrencies extends Error {
  override readonly name = 'MixedCurrencies';

  constructor() {
    super('the entries of a transaction share one currency');
  }
}

/** An entry whose currency is not its account's (LED-R07). */
export class EntryCurrencyMismatch extends Error {
  override readonly name = 'EntryCurrencyMismatch';

  constructor() {
    super("an entry's currency is its account's currency");
  }
}

/** Entries whose currency is not the transaction's (LED-R07). */
export class TransactionCurrencyMismatch extends Error {
  override readonly name = 'TransactionCurrencyMismatch';

  constructor() {
    super("a transaction's currency is its entries' currency");
  }
}

/** Entries that do not sum to zero (LED-R05). */
export class Unbalanced extends Error {
  override readonly name = 'Unbalanced';

  constructor() {
    super('the entries of a transaction sum to zero');
  }
}

/**
 * A credit that would take a cached balance above 9223372036854775807 (LED-R26): 422
 * `/problems/balance-limit-exceeded`, or `destination-unavailable` on a transfer (LED-R29).
 */
export class BalanceLimitExceeded extends Error {
  override readonly name = 'BalanceLimitExceeded';

  constructor() {
    super('the balance would exceed its limit');
  }
}

/** An amount outside 1 to 9223372036854775807 minor units (SYS-R07, LED-R27). */
export class AmountOutOfRange extends Error {
  override readonly name = 'AmountOutOfRange';

  constructor() {
    super('an amount is 1 to 9223372036854775807 minor units');
  }
}

/** Balance arithmetic given anything but a `bigint` (LED-R27). */
export class InvalidAmountType extends Error {
  override readonly name = 'InvalidAmountType';

  constructor() {
    super('amounts and balances are bigint minor units');
  }
}

/** Reversing a transaction of kind `reversal` (REV-R07): 422 `/problems/transaction-not-reversible`. */
export class TransactionNotReversible extends Error {
  override readonly name = 'TransactionNotReversible';

  constructor() {
    super('a reversal cannot be reversed');
  }
}

/** The database's refusal of a second reversal: SQLSTATE and constraint, never the driver error. */
export interface AlreadyReversedCause {
  sqlstate: string;
  constraint: string;
}

/**
 * The transaction already has a reversal (REV-R06): 409 `/problems/already-reversed`. Found by the
 * check after the locks, without a cause, or raised by the unique constraint of REV-R05 at the
 * reversal's insert, with its SQLSTATE and constraint as `cause` (plan 002 section 4).
 */
export class AlreadyReversed extends Error {
  override readonly name = 'AlreadyReversed';
  declare readonly cause: AlreadyReversedCause | undefined;

  constructor(options?: { cause: AlreadyReversedCause }) {
    super('the transaction already has a reversal', options);
  }
}
