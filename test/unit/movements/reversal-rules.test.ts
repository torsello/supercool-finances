import { describe, expect, it } from 'vitest';
import { AccountNotActive, type AccountStatus } from '../../../src/modules/accounts/index.js';
import {
  AlreadyReversed,
  BalanceLimitExceeded,
  LedgerTransaction,
  reversalOf,
  type AccountRef,
} from '../../../src/modules/ledger/index.js';
import { InsufficientFundsForReversal } from '../../../src/modules/movements/domain/errors.js';
import {
  checkReversal,
  type ReversalAccount,
} from '../../../src/modules/movements/domain/reversal-rules.js';

const MAX = 9223372036854775807n;
const A1 = '0192f0c4-0000-7000-8000-0000000000a1';
const B1 = '0192f0c4-0000-7000-8000-0000000000b1';
const S = '0192f0c4-0000-7000-8000-0000000000e0';
const ORIGINAL = '0192f0c4-0000-7000-8000-0000000000d1';

const ref = (id: string): AccountRef => ({ id, kind: 'customer', currency: 'EUR' });
const settlement: AccountRef = { id: S, kind: 'system', currency: 'EUR' };

function reversal(original: LedgerTransaction): LedgerTransaction {
  return reversalOf({
    id: ORIGINAL,
    kind: original.kind,
    currency: original.currency,
    entries: original.entries,
  });
}

/** Reverses +1050 on A1: debits A1. */
const ofDeposit = reversal(LedgerTransaction.deposit(ref(A1), settlement, 1050n));
/** Reverses −1200 on A1: credits A1 and debits S only. */
const ofWithdrawal = reversal(LedgerTransaction.withdrawal(ref(A1), settlement, 1200n));
/** Reverses A1 → B1 of 300: credits A1, debits B1. */
const ofTransfer = reversal(LedgerTransaction.transfer(ref(A1), ref(B1), 300n));

function locked(
  ...rows: [id: string, status: AccountStatus, balance: bigint][]
): Map<string, ReversalAccount> {
  return new Map(rows.map(([id, status, balance]) => [id, { status, balance }]));
}

function check(
  transaction: LedgerTransaction,
  accounts: Map<string, ReversalAccount>,
  alreadyReversed = false,
): void {
  checkReversal(transaction, { alreadyReversed, accounts });
}

describe('reversal rules (spec 004 section 1.4, steps 5 to 8)', () => {
  it('REV-R22 answers the first failure: existing reversal, then status, then funds, then the balance limit', () => {
    // Every later check fails as well: B1 closed with 0, A1 at the limit.
    const everything = locked([A1, 'active', MAX], [B1, 'closed', 0n]);
    expect(() => {
      check(ofTransfer, everything, true);
    }).toThrow(AlreadyReversed);
    expect(() => {
      check(ofTransfer, everything);
    }).toThrow(AccountNotActive);
    // A closed account lacking the funds answers its status (REV-AC24).
    expect(() => {
      check(ofDeposit, locked([A1, 'closed', 0n]));
    }).toThrow(AccountNotActive);
    // The debited B1 lacks the funds and the credited A1 would overflow: funds come first.
    expect(() => {
      check(ofTransfer, locked([A1, 'active', MAX], [B1, 'active', 299n]));
    }).toThrow(InsufficientFundsForReversal);
    expect(() => {
      check(ofTransfer, locked([A1, 'active', MAX], [B1, 'active', 300n]));
    }).toThrow(BalanceLimitExceeded);
  });

  it('REV-R06 an existing reversal is refused whatever the accounts state, with no database cause', () => {
    let thrown: unknown;
    try {
      check(ofDeposit, locked([A1, 'active', 5000n]), true);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AlreadyReversed);
    expect((thrown as AlreadyReversed).cause).toBeUndefined();
  });

  it('REV-R09 REV-R10 frozen accounts pass and a closed one fails, on the debited and the credited side', () => {
    expect(() => {
      check(ofTransfer, locked([A1, 'frozen', 0n], [B1, 'frozen', 300n]));
    }).not.toThrow();
    expect(() => {
      check(ofDeposit, locked([A1, 'frozen', 1050n]));
    }).not.toThrow();
    expect(() => {
      check(ofWithdrawal, locked([A1, 'closed', 0n]));
    }).toThrow(AccountNotActive);
    expect(() => {
      check(ofTransfer, locked([A1, 'closed', 0n], [B1, 'active', 300n]));
    }).toThrow(AccountNotActive);
    expect(() => {
      check(ofTransfer, locked([A1, 'active', 0n], [B1, 'closed', 0n]));
    }).toThrow(AccountNotActive);
  });

  it('REV-R08 checks funds only on the accounts the reversal debits, and lets it take the whole balance', () => {
    expect(() => {
      check(ofDeposit, locked([A1, 'active', 1049n]));
    }).toThrow(InsufficientFundsForReversal);
    expect(() => {
      check(ofDeposit, locked([A1, 'active', 1050n]));
    }).not.toThrow();
    expect(() => {
      check(ofTransfer, locked([A1, 'active', 0n], [B1, 'active', 299n]));
    }).toThrow(InsufficientFundsForReversal);
    // A withdrawal's reversal debits S only, which needs no funds: A1 with 0 is credited.
    expect(() => {
      check(ofWithdrawal, locked([A1, 'active', 0n]));
    }).not.toThrow();
  });

  it('REV-R11 checks the balance limit only on the accounts the reversal credits', () => {
    expect(() => {
      check(ofWithdrawal, locked([A1, 'active', MAX - 1199n]));
    }).toThrow(BalanceLimitExceeded);
    expect(() => {
      check(ofWithdrawal, locked([A1, 'active', MAX - 1200n]));
    }).not.toThrow();
    // B1 at the limit is only debited.
    expect(() => {
      check(ofTransfer, locked([A1, 'active', 0n], [B1, 'active', MAX]));
    }).not.toThrow();
  });

  it('REV-R18 a customer account of the reversal that was not locked is a defect, not a rejection', () => {
    expect(() => {
      check(ofTransfer, locked([A1, 'active', 0n]));
    }).toThrow(/not locked/);
  });
});
