import { describe, expect, it } from 'vitest';
import {
  Account,
  type AccountStatus,
  type StatusAction,
} from '../../../src/modules/accounts/domain/account.js';
import {
  AccountBalanceNotZero,
  InvalidStatusTransition,
} from '../../../src/modules/accounts/domain/errors.js';

function account(status: AccountStatus, balance: bigint): Account {
  return Account.restore({
    id: '0192f0c4-0000-7000-8000-000000000001',
    ownerId: '0192f0c4-0000-7000-8000-0000000000aa',
    currency: 'EUR',
    status,
    balance,
  });
}

type Outcome =
  AccountStatus | 'unchanged' | typeof InvalidStatusTransition | typeof AccountBalanceNotZero;

/** The lifecycle table of plan 001 section 4: current status, action, balance, outcome. */
const LIFECYCLE: [AccountStatus, StatusAction, bigint, Outcome][] = [
  ['active', 'freeze', 0n, 'frozen'],
  ['active', 'freeze', 2500n, 'frozen'],
  ['active', 'unfreeze', 0n, 'unchanged'],
  ['active', 'unfreeze', 2500n, 'unchanged'],
  ['active', 'close', 0n, 'closed'],
  ['active', 'close', 1n, AccountBalanceNotZero],
  ['active', 'close', 9223372036854775807n, AccountBalanceNotZero],
  ['frozen', 'freeze', 0n, 'unchanged'],
  ['frozen', 'freeze', 2500n, 'unchanged'],
  ['frozen', 'unfreeze', 0n, 'active'],
  ['frozen', 'unfreeze', 2500n, 'active'],
  ['frozen', 'close', 0n, 'closed'],
  ['frozen', 'close', 2500n, AccountBalanceNotZero],
  ['closed', 'freeze', 0n, InvalidStatusTransition],
  ['closed', 'unfreeze', 0n, InvalidStatusTransition],
  ['closed', 'close', 0n, 'unchanged'],
];

describe('Account lifecycle (plan 001 section 4)', () => {
  it.each(LIFECYCLE)(
    'ACC-R11 ACC-R12 ACC-R13 ACC-R14 ACC-R15 ACC-R16 %s account, %s, balance %s',
    (status, action, balance, outcome) => {
      const subject = account(status, balance);
      if (typeof outcome === 'function') {
        expect(() => subject.changeStatus(action)).toThrow(outcome);
      } else if (outcome === 'unchanged') {
        expect(subject.changeStatus(action)).toEqual({ kind: 'unchanged' });
      } else {
        expect(subject.changeStatus(action)).toEqual({ kind: 'changed', status: outcome });
      }
      expect(subject.status).toBe(status);
      expect(subject.balance).toBe(balance);
    },
  );

  it('ACC-R16 cannot hold a closed account with a balance other than 0', () => {
    expect(() => account('closed', 1n)).toThrow(RangeError);
  });

  it('ACC-R14 ACC-R16 carries the refused status and action on the typed errors', () => {
    expect(() => account('closed', 0n).changeStatus('freeze')).toThrow(
      expect.objectContaining({ status: 'closed', action: 'freeze' }),
    );
    expect(() => account('frozen', 2500n).changeStatus('close')).toThrow(
      expect.objectContaining({ status: 'frozen', action: 'close' }),
    );
  });

  it('ACC-R19 lets only an active account move money', () => {
    expect(account('active', 0n).canMoveMoney()).toBe(true);
    expect(account('frozen', 100n).canMoveMoney()).toBe(false);
    expect(account('closed', 0n).canMoveMoney()).toBe(false);
  });

  it('ACC-R01 opens an active account with balance 0 for its owner, in its currency', () => {
    const opened = Account.open({
      id: '0192f0c4-0000-7000-8000-000000000002',
      ownerId: '0192f0c4-0000-7000-8000-0000000000bb',
      currency: 'JPY',
    });
    expect(opened).toMatchObject({
      id: '0192f0c4-0000-7000-8000-000000000002',
      ownerId: '0192f0c4-0000-7000-8000-0000000000bb',
      currency: 'JPY',
      status: 'active',
      balance: 0n,
    });
  });
});
