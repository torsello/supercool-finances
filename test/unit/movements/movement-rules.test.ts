import { describe, expect, it } from 'vitest';
import {
  Account,
  AccountNotActive,
  type AccountStatus,
} from '../../../src/modules/accounts/index.js';
import { BalanceLimitExceeded, type CurrencyCode } from '../../../src/modules/ledger/index.js';
import {
  CurrencyMismatch,
  DestinationUnavailable,
  InsufficientFunds,
} from '../../../src/modules/movements/domain/errors.js';
import {
  depositTransaction,
  transferTransaction,
  withdrawalTransaction,
  type Destination,
} from '../../../src/modules/movements/domain/movement-rules.js';

const MAX = 9223372036854775807n;
const C1 = '0192f0c4-0000-7000-8000-0000000000c1';
const C2 = '0192f0c4-0000-7000-8000-0000000000c2';
const S = { id: '0192f0c4-0000-7000-8000-0000000000e0', currency: 'EUR' } as const;

let next = 0;
function account(
  status: AccountStatus,
  balance: bigint,
  options: { ownerId?: string; currency?: CurrencyCode } = {},
): Account {
  next += 1;
  return Account.restore({
    id: `0192f0c4-0000-7000-8000-${next.toString(16).padStart(12, '0')}`,
    ownerId: options.ownerId ?? C1,
    currency: options.currency ?? 'EUR',
    status,
    balance,
  });
}

const customer = (destination: Account): Destination => ({
  kind: 'customer',
  account: destination,
});

describe('deposit and withdrawal rules (spec 003 section 1.4)', () => {
  it('MOV-R12 MOV-R17 a deposit checks the status before the balance limit', () => {
    expect(() => depositTransaction(account('frozen', MAX), S, 1n)).toThrow(AccountNotActive);
    expect(() => depositTransaction(account('closed', 0n), S, 1n)).toThrow(AccountNotActive);
    expect(() => depositTransaction(account('active', MAX), S, 1n)).toThrow(BalanceLimitExceeded);
    const target = account('active', MAX - 1n);
    const transaction = depositTransaction(target, S, 1n);
    expect(transaction.kind).toBe('deposit');
    expect(transaction.balanceChanges()).toEqual([{ accountId: target.id, change: 1n }]);
  });

  it('MOV-R12 MOV-R16 MOV-R17 a withdrawal checks the status before the funds, and may take the whole balance', () => {
    expect(() => withdrawalTransaction(account('frozen', 0n), S, 100n)).toThrow(AccountNotActive);
    expect(() => withdrawalTransaction(account('closed', 0n), S, 1n)).toThrow(AccountNotActive);
    expect(() => withdrawalTransaction(account('active', 99n), S, 100n)).toThrow(InsufficientFunds);
    const source = account('active', 100n);
    expect(withdrawalTransaction(source, S, 100n).balanceChanges()).toEqual([
      { accountId: source.id, change: -100n },
    ]);
  });
});

describe('transfer rules (spec 003 section 1.4)', () => {
  it('MOV-R17 checks the source status, then its funds, before any destination check', () => {
    const missing: Destination = { kind: 'missing' };
    expect(() => transferTransaction(C1, account('frozen', 0n), missing, 100n)).toThrow(
      AccountNotActive,
    );
    for (const destination of [
      missing,
      { kind: 'system' } as const,
      customer(account('frozen', 0n)),
      customer(account('active', 0n, { currency: 'USD' })),
      customer(account('active', MAX, { ownerId: C2 })),
    ]) {
      expect(() => transferTransaction(C1, account('active', 50n), destination, 100n)).toThrow(
        InsufficientFunds,
      );
    }
  });

  it('MOV-R13 MOV-R14 an own destination answers its status, then its currency', () => {
    const source = () => account('active', 1000n);
    expect(() => transferTransaction(C1, source(), customer(account('frozen', 0n)), 100n)).toThrow(
      AccountNotActive,
    );
    expect(() =>
      transferTransaction(C1, source(), customer(account('closed', 0n, { currency: 'USD' })), 100n),
    ).toThrow(AccountNotActive);
    expect(() =>
      transferTransaction(C1, source(), customer(account('active', 0n, { currency: 'USD' })), 100n),
    ).toThrow(CurrencyMismatch);
  });

  it('MOV-R15 every other unavailable destination, the overflowing own one included, gives one DestinationUnavailable', () => {
    const unavailable: Destination[] = [
      { kind: 'missing' },
      { kind: 'system' },
      customer(account('frozen', 0n, { ownerId: C2 })),
      customer(account('closed', 0n, { ownerId: C2 })),
      customer(account('active', 0n, { ownerId: C2, currency: 'USD' })),
      customer(account('active', MAX, { ownerId: C2 })),
      customer(account('active', MAX)),
    ];
    const messages = new Set<string>();
    for (const destination of unavailable) {
      let caught: unknown;
      try {
        transferTransaction(C1, account('active', 1000n), destination, 100n);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DestinationUnavailable);
      messages.add((caught as Error).message);
    }
    expect(messages.size).toBe(1);
  });

  it('MOV-R03 builds the transfer to another customer and to an own account', () => {
    const source = account('active', 1000n);
    const other = account('active', 0n, { ownerId: C2 });
    const own = account('active', 5n);
    for (const destination of [other, own]) {
      const transaction = transferTransaction(C1, source, customer(destination), 1000n);
      expect(transaction.kind).toBe('transfer');
      expect(transaction.entries.map((e) => [e.accountId, e.amount])).toEqual([
        [source.id, -1000n],
        [destination.id, 1000n],
      ]);
    }
  });
});
