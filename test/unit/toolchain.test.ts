import { describe, expect, it } from 'vitest';
import { z } from 'zod';

describe('toolchain smoke', () => {
  it('validates amounts as decimal-digit strings in minor units', () => {
    const amount = z.string().regex(/^[1-9]\d{0,18}$/);

    expect(amount.safeParse('1050').success).toBe(true);
    expect(amount.safeParse('0').success).toBe(false);
    expect(amount.safeParse('0001050').success).toBe(false);
    expect(amount.safeParse('10.50').success).toBe(false);
  });

  it('shows why amounts are bigint, not number', () => {
    expect(Number.MAX_SAFE_INTEGER + 2).toBe(Number.MAX_SAFE_INTEGER + 1);
    expect(9007199254740993n).not.toBe(9007199254740992n);
  });
});
