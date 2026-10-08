import { describe, expect, it } from 'vitest';
import { planLocks } from '../../../src/modules/movements/domain/lock-plan.js';

const a = '018f2a00-0000-7000-8000-00000000000a';
const b = '018f2a00-0000-7000-8000-00000000000b';
const B = '018F2A00-0000-7000-8000-00000000000B';
const S = '018f2a00-0000-7000-8000-0000000000ee';

const customer = (id: string) => ({ id, kind: 'customer' as const });
const settlement = { id: S, kind: 'system' as const };

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
});
