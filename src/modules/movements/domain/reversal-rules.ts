import { AccountNotActive, type AccountStatus } from '../../accounts/index.js';
import {
  AlreadyReversed,
  credit,
  toAmount,
  type BalanceChange,
  type LedgerTransaction,
} from '../../ledger/index.js';
import { InsufficientFundsForReversal } from './errors.js';

/** A customer account of the reversal, as read under its row lock (REV-R18). */
export interface ReversalAccount {
  status: AccountStatus;
  balance: bigint;
}

/** What steps 5 to 8 read after every lock is held. */
export interface ReversalState {
  /** Whether the original already has a reversal (step 5). */
  alreadyReversed: boolean;
  /** Every customer account of the original, by canonical id. */
  accounts: ReadonlyMap<string, ReversalAccount>;
}

function lockedRow(state: ReversalState, change: BalanceChange): ReversalAccount {
  const row = state.accounts.get(change.accountId);
  if (row === undefined) throw new Error(`customer account ${change.accountId} was not locked`);
  return row;
}

/**
 * Steps 5 to 8 of section 1.4 of spec 004, in order, each over every customer account ascending
 * by id, and throws the first failure (REV-R22): an existing reversal (REV-R06); a `closed`
 * account, while `frozen` passes (REV-R09, REV-R10); the funds of each account the reversal
 * debits (REV-R08); the balance limit of each account it credits (REV-R11). Each account's change
 * is its entry sum in the reversal: the negated sum of its entries in the original.
 */
export function checkReversal(reversal: LedgerTransaction, state: ReversalState): void {
  if (state.alreadyReversed) throw new AlreadyReversed();
  const changes = reversal.balanceChanges();
  for (const change of changes) {
    if (lockedRow(state, change).status === 'closed') throw new AccountNotActive();
  }
  for (const change of changes) {
    if (change.change < 0n && -change.change > lockedRow(state, change).balance) {
      throw new InsufficientFundsForReversal();
    }
  }
  for (const change of changes) {
    if (change.change > 0n) credit(lockedRow(state, change).balance, toAmount(change.change));
  }
}
