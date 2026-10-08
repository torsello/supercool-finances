import { AccountNotActive, type Account } from '../../accounts/index.js';
import {
  BalanceLimitExceeded,
  credit,
  LedgerTransaction,
  toAmount,
  type CurrencyCode,
} from '../../ledger/index.js';
import { CurrencyMismatch, DestinationUnavailable, InsufficientFunds } from './errors.js';

/** The settlement account of the movement's currency (LED-R08). */
export interface SettlementRef {
  id: string;
  currency: CurrencyCode;
}

/** A transfer destination, as the lookup and the lock found it (plan 003 section 4). */
export type Destination =
  { kind: 'missing' } | { kind: 'system' } | { kind: 'customer'; account: Account };

function customerRef(account: Account) {
  return { id: account.id, kind: 'customer' as const, currency: account.currency };
}

function systemRef(settlement: SettlementRef) {
  return { id: settlement.id, kind: 'system' as const, currency: settlement.currency };
}

/**
 * Steps 5 and 8 of section 1.4 of spec 003, on the row read under its lock: the status, then the
 * balance limit (MOV-R12, LED-R26).
 */
export function depositTransaction(
  account: Account,
  settlement: SettlementRef,
  amount: bigint,
): LedgerTransaction {
  if (!account.canMoveMoney()) throw new AccountNotActive();
  credit(account.balance, toAmount(amount));
  return LedgerTransaction.deposit(customerRef(account), systemRef(settlement), amount);
}

/** Steps 5 and 6: the status, then the funds (MOV-R12, MOV-R16). */
export function withdrawalTransaction(
  account: Account,
  settlement: SettlementRef,
  amount: bigint,
): LedgerTransaction {
  if (!account.canMoveMoney()) throw new AccountNotActive();
  if (amount > account.balance) throw new InsufficientFunds();
  return LedgerTransaction.withdrawal(customerRef(account), systemRef(settlement), amount);
}

/** Whether the destination can be credited without its balance exceeding the limit. */
function overflows(destination: Account, amount: bigint): boolean {
  try {
    credit(destination.balance, toAmount(amount));
    return false;
  } catch (error) {
    if (error instanceof BalanceLimitExceeded) return true;
    throw error;
  }
}

/**
 * Steps 5 to 7: the source's status and funds; an own destination's status, then currency
 * (MOV-R13, MOV-R14); then every condition of `destination-unavailable` at one step, so the
 * answer never depends on which one holds (MOV-R15, MOV-R17).
 */
export function transferTransaction(
  callerId: string,
  source: Account,
  destination: Destination,
  amount: bigint,
): LedgerTransaction {
  if (!source.canMoveMoney()) throw new AccountNotActive();
  if (amount > source.balance) throw new InsufficientFunds();
  if (destination.kind !== 'customer') throw new DestinationUnavailable();

  const target = destination.account;
  const own = target.ownerId === callerId;
  if (own && !target.canMoveMoney()) throw new AccountNotActive();
  if (own && target.currency !== source.currency) throw new CurrencyMismatch();
  if (!target.canMoveMoney() || target.currency !== source.currency || overflows(target, amount)) {
    throw new DestinationUnavailable();
  }
  return LedgerTransaction.transfer(customerRef(source), customerRef(target), amount);
}
