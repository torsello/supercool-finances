import type { CurrencyCode } from '../../ledger/index.js';
import { AccountBalanceNotZero, InvalidStatusTransition } from './errors.js';

export type AccountStatus = 'active' | 'frozen' | 'closed';
export type StatusAction = 'freeze' | 'unfreeze' | 'close';

/** The outcome of a status request that the lifecycle allows (plan 001 section 4). */
export type StatusDecision =
  { readonly kind: 'changed'; readonly status: AccountStatus } | { readonly kind: 'unchanged' };

export interface AccountState {
  id: string;
  ownerId: string;
  currency: CurrencyCode;
  status: AccountStatus;
  /** Cached balance in minor units. */
  balance: bigint;
}

const UNCHANGED: StatusDecision = Object.freeze({ kind: 'unchanged' });

function changed(status: AccountStatus): StatusDecision {
  return { kind: 'changed', status };
}

/**
 * A customer account: its status, its cached balance and the lifecycle of section 1.2 of spec 001.
 * Status and balance are those read under the account's row lock (ACC-R17).
 */
export class Account {
  readonly id: string;
  readonly ownerId: string;
  readonly currency: CurrencyCode;
  readonly status: AccountStatus;
  readonly balance: bigint;

  private constructor(state: AccountState) {
    if (state.balance < 0n) throw new RangeError('a customer account balance is never negative');
    if (state.status === 'closed' && state.balance !== 0n) {
      throw new RangeError('a closed account has balance 0');
    }
    this.id = state.id;
    this.ownerId = state.ownerId;
    this.currency = state.currency;
    this.status = state.status;
    this.balance = state.balance;
  }

  /** A new account: `active` with balance 0, owned by its creator (ACC-R01). */
  static open(props: { id: string; ownerId: string; currency: CurrencyCode }): Account {
    return new Account({ ...props, status: 'active', balance: 0n });
  }

  static restore(state: AccountState): Account {
    return new Account(state);
  }

  /** Deposits, withdrawals and transfers need an `active` account on every side (ACC-R19). */
  canMoveMoney(): boolean {
    return this.status === 'active';
  }

  /** The lifecycle table of plan 001 section 4 (ACC-R11 to ACC-R16). */
  changeStatus(action: StatusAction): StatusDecision {
    switch (action) {
      case 'freeze':
        if (this.status === 'closed') throw new InvalidStatusTransition(this.status, action);
        return this.status === 'frozen' ? UNCHANGED : changed('frozen');
      case 'unfreeze':
        if (this.status === 'closed') throw new InvalidStatusTransition(this.status, action);
        return this.status === 'active' ? UNCHANGED : changed('active');
      case 'close':
        if (this.status === 'closed') return UNCHANGED;
        if (this.balance !== 0n) throw new AccountBalanceNotZero(this.status, action);
        return changed('closed');
    }
  }
}
