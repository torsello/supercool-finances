import { describe, expect, it } from 'vitest';
import {
  LedgerTransaction,
  reversalOf,
  type AccountRef,
} from '../../../src/modules/ledger/index.js';
import { planLocks } from '../../../src/modules/movements/domain/lock-plan.js';

const a = '018f2a00-0000-7000-8000-00000000000a';
const b = '018f2a00-0000-7000-8000-00000000000b';
const B = '018F2A00-0000-7000-8000-00000000000B';
const S = '018f2a00-0000-7000-8000-0000000000ee';

const customer = (id: string) => ({ id, kind: 'customer' as const });
const settlement = { id: S, kind: 'system' as const };

const ref = (id: string): AccountRef => ({ id, kind: 'customer', currency: 'EUR' });
const settlementRef: AccountRef = { id: S, kind: 'system', currency: 'EUR' };

/** The lock plan of reversing `original`: `planLocks` over the accounts of the original's entries. */
function reversalPlan(original: LedgerTransaction): string[] {
  const id = '018f2a00-0000-7000-8000-0000000000f0';
  // Built first, as the use case does, so a plan exists only for a reversible original.
  reversalOf({ id, kind: original.kind, currency: original.currency, entries: original.entries });
  return planLocks(
    original.entries.map((entry) => ({ id: entry.accountId, kind: entry.accountKind })),
  );
}

describe('lock plan', () => {
  it('MOV-AC15 locks customer accounts in ascending canonical lowercase order, never a system account', () => {
    // As plain strings the uppercase id sorts first; in canonical form a comes before b.
    expect([a, B].sort()).toEqual([B, a]);
    const plans = {
      transferFromUpperBToA: planLocks([customer(B), customer(a)]),
      transferFromAToB: planLocks([customer(a), customer(b)]),
      transferFromAToS: planLocks([customer(a), settlement]),
      depositIntoUpperB: planLocks([customer(B), settlement]),
      withdrawalFromA: planLocks([customer(a), settlement]),
    };
    expect(plans).toEqual({
      transferFromUpperBToA: [a, b],
      transferFromAToB: [a, b],
      transferFromAToS: [a],
      depositIntoUpperB: [b],
      withdrawalFromA: [a],
    });
    expect(Object.values(plans).some((plan) => plan.includes(S))).toBe(false);
  });

  it('MOV-R18 MOV-R30 locks an account named twice, in either case, once', () => {
    expect(planLocks([customer(b), customer(B), customer(a), customer(a)])).toEqual([a, b]);
    expect(planLocks([])).toEqual([]);
  });

  it('REV-AC20 plans the locks of a reversal like a transfer: customer accounts of the original, ascending, lowercase, never S', () => {
    const plans = {
      reversalOfTransferFromUpperBToA: reversalPlan(LedgerTransaction.transfer(ref(B), ref(a), 5n)),
      reversalOfTransferFromAToB: reversalPlan(LedgerTransaction.transfer(ref(a), ref(b), 5n)),
      reversalOfDepositIntoUpperB: reversalPlan(
        LedgerTransaction.deposit(ref(B), settlementRef, 5n),
      ),
      reversalOfWithdrawalFromA: reversalPlan(
        LedgerTransaction.withdrawal(ref(a), settlementRef, 5n),
      ),
      transferFromAToS: planLocks([customer(a), settlement]),
    };
    expect(plans).toEqual({
      reversalOfTransferFromUpperBToA: [a, b],
      reversalOfTransferFromAToB: [a, b],
      reversalOfDepositIntoUpperB: [b],
      reversalOfWithdrawalFromA: [a],
      transferFromAToS: [a],
    });
    // The same plan as the transfers themselves (MOV-AC15).
    expect(plans.reversalOfTransferFromUpperBToA).toEqual(planLocks([customer(B), customer(a)]));
    expect(plans.reversalOfTransferFromAToB).toEqual(planLocks([customer(a), customer(b)]));
    expect(Object.values(plans).some((plan) => plan.includes(S))).toBe(false);
  });
});
