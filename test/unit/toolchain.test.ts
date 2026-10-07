import { describe, expect, it } from 'vitest';
import { z } from 'zod';

describe('toolchain smoke', () => {
  it('validates amounts as decimal-digit strings in minor units', () => {
    const BIGINT_MAX = 9223372036854775807n; // PostgreSQL bigint maximum, 2^63 - 1
    const amount = z
      .string()
      // abort: Zod 4 runs later checks even after a failed one, and BigInt('10.50') throws.
      .regex(/^[1-9]\d{0,18}$/, { abort: true })
      .refine((value) => BigInt(value) <= BIGINT_MAX);

    expect(amount.safeParse('1050').success).toBe(true);
    expect(amount.safeParse('0').success).toBe(false);
    expect(amount.safeParse('0001050').success).toBe(false);
    expect(amount.safeParse('10.50').success).toBe(false);
    expect(amount.safeParse((2n ** 63n - 1n).toString()).success).toBe(true);
    expect(amount.safeParse((2n ** 63n).toString()).success).toBe(false);
  });

  it('shows why amounts are bigint, not number', () => {
    expect(Number.MAX_SAFE_INTEGER + 2).toBe(Number.MAX_SAFE_INTEGER + 1);
    expect(9007199254740993n).not.toBe(9007199254740992n);
  });
});
