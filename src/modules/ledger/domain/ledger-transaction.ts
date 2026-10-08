import type { CurrencyCode } from './currency.js';
import {
  EntryCurrencyMismatch,
  InvalidAmountType,
  MixedCurrencies,
  TooFewEntries,
  TransactionCurrencyMismatch,
  TransactionNotReversible,
  Unbalanced,
  ZeroAmount,
} from './errors.js';

export type TransactionKind = 'deposit' | 'withdrawal' | 'transfer' | 'reversal';
export type AccountKind = 'customer' | 'system';

/** One entry to build, with what the ledger checks of its account (plan 002 section 3). */
export interface LedgerEntryInput {
  accountId: string;
  accountKind: AccountKind;
  accountCurrency: CurrencyCode;
  /** Signed minor units: positive credits the account, negative debits it (LED-R02). */
  amount: bigint;
  currency: CurrencyCode;
}

export type LedgerEntry = Readonly<LedgerEntryInput>;

/** What a builder needs of an account. */
export interface AccountRef {
  id: string;
  kind: AccountKind;
  currency: CurrencyCode;
}

/** A transaction as the ledger recorded it, under the id it was written with. */
export interface RecordedTransaction {
  id: string;
  kind: TransactionKind;
  currency: CurrencyCode;
  entries: readonly LedgerEntryInput[];
}

export interface BalanceChange {
  accountId: string;
  change: bigint;
}

function entryOf(account: AccountRef, amount: bigint): LedgerEntryInput {
  return {
    accountId: account.id,
    accountKind: account.kind,
    accountCurrency: account.currency,
    amount,
    currency: account.currency,
  };
}

function requireMovementAmount(amount: bigint): void {
  if (typeof amount !== 'bigint') throw new InvalidAmountType();
  // The direction of a movement comes from its kind, never from the sign of its amount.
  if (amount <= 0n) throw new RangeError('a movement amount is a positive number of minor units');
}

function requireKind(account: AccountRef, kind: AccountKind): void {
  if (account.kind !== kind) throw new RangeError(`expected a ${kind} account`);
}

/**
 * One money movement: two or more signed entries in one currency that sum to zero (LED-R01 to
 * LED-R07). It can only be built through `create`, which checks every invariant.
 */
export class LedgerTransaction {
  readonly kind: TransactionKind;
  readonly currency: CurrencyCode;
  readonly entries: readonly LedgerEntry[];
  /** The transaction a reversal reverses; `null` for every other kind (REV-R01). */
  readonly reversedTransactionId: string | null;

  private constructor(
    kind: TransactionKind,
    currency: CurrencyCode,
    entries: LedgerEntry[],
    reversedTransactionId: string | null,
  ) {
    this.kind = kind;
    this.currency = currency;
    this.entries = Object.freeze(entries);
    this.reversedTransactionId = reversedTransactionId;
  }

  /** Checks, in this order, and throws the first failure (plan 002 section 3, LED-AC02). */
  static create(props: {
    kind: TransactionKind;
    currency: CurrencyCode;
    entries: readonly LedgerEntryInput[];
    reversedTransactionId?: string;
  }): LedgerTransaction {
    const reversedTransactionId = props.reversedTransactionId ?? null;
    // The link of a reversal, as the check transactions_reversal_link holds it (REV-R01).
    if ((props.kind === 'reversal') !== (reversedTransactionId !== null)) {
      throw new RangeError('a reversal, and only a reversal, links the transaction it reverses');
    }
    const entries = props.entries.map((entry) => Object.freeze({ ...entry }));
    if (entries.length < 2) throw new TooFewEntries();
    if (entries.some((entry) => typeof entry.amount !== 'bigint')) throw new InvalidAmountType();
    if (entries.some((entry) => entry.amount === 0n)) throw new ZeroAmount();
    if (new Set(entries.map((entry) => entry.currency)).size > 1) throw new MixedCurrencies();
    if (entries.some((entry) => entry.currency !== entry.accountCurrency)) {
      throw new EntryCurrencyMismatch();
    }
    if (entries.some((entry) => entry.currency !== props.currency)) {
      throw new TransactionCurrencyMismatch();
    }
    if (entries.reduce((sum, entry) => sum + entry.amount, 0n) !== 0n) throw new Unbalanced();
    return new LedgerTransaction(props.kind, props.currency, entries, reversedTransactionId);
  }

  /** +A on the customer account, −A on the settlement account (table 1.1 of spec 002). */
  static deposit(account: AccountRef, settlement: AccountRef, amount: bigint): LedgerTransaction {
    requireMovementAmount(amount);
    requireKind(account, 'customer');
    requireKind(settlement, 'system');
    return LedgerTransaction.create({
      kind: 'deposit',
      currency: account.currency,
      entries: [entryOf(account, amount), entryOf(settlement, -amount)],
    });
  }

  /** −A on the customer account, +A on the settlement account. */
  static withdrawal(
    account: AccountRef,
    settlement: AccountRef,
    amount: bigint,
  ): LedgerTransaction {
    requireMovementAmount(amount);
    requireKind(account, 'customer');
    requireKind(settlement, 'system');
    return LedgerTransaction.create({
      kind: 'withdrawal',
      currency: account.currency,
      entries: [entryOf(account, -amount), entryOf(settlement, amount)],
    });
  }

  /** −A on the source, +A on the destination, never with a system account. */
  static transfer(source: AccountRef, destination: AccountRef, amount: bigint): LedgerTransaction {
    requireMovementAmount(amount);
    requireKind(source, 'customer');
    requireKind(destination, 'customer');
    return LedgerTransaction.create({
      kind: 'transfer',
      currency: source.currency,
      entries: [entryOf(source, -amount), entryOf(destination, amount)],
    });
  }

  /**
   * The change of each customer account's cached balance: the sum of its entries, ascending by
   * id, the order the balances are updated in. System accounts never get one (LED-R11, LED-R13).
   */
  balanceChanges(): BalanceChange[] {
    const changes = new Map<string, bigint>();
    for (const entry of this.entries) {
      if (entry.accountKind !== 'customer') continue;
      changes.set(entry.accountId, (changes.get(entry.accountId) ?? 0n) + entry.amount);
    }
    return [...changes]
      .map(([accountId, change]) => ({ accountId, change }))
      .sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0));
  }
}

/**
 * The reversal of a recorded transaction (table 1.2 of spec 004): kind `reversal`, the original's
 * currency, the link to it, and every entry negated on the same account, built through `create`
 * so it holds the same invariants. A reversal is never reversed (REV-R01, REV-R07); the original
 * is never changed.
 */
export function reversalOf(original: RecordedTransaction): LedgerTransaction {
  if (original.kind === 'reversal') throw new TransactionNotReversible();
  return LedgerTransaction.create({
    kind: 'reversal',
    currency: original.currency,
    entries: original.entries.map((entry) => ({ ...entry, amount: -entry.amount })),
    reversedTransactionId: original.id,
  });
}
