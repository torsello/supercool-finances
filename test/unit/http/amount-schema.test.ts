import { describe, expect, it } from 'vitest';
import { amountSchema } from '../../../src/platform/http/schemas/amount.js';

describe('the shared amount schema', () => {
  it('SYS-AC06 accepts decimal-digit strings from 1 to the bigint maximum as bigint, and rejects every other value', () => {
    expect(amountSchema.parse('1')).toBe(1n);
    expect(amountSchema.parse('1050')).toBe(1050n);
    expect(amountSchema.parse('9223372036854775807')).toBe(9223372036854775807n);

    for (const value of [
      '0',
      '-5',
      '+5',
      '01050',
      '10.50',
      '10,50',
      '1e3',
      ' 1050',
      '1050 ',
      '0x10',
      '0b11',
      '0o7',
      '1_000',
      '',
      '9223372036854775808',
      1050,
    ]) {
      expect(amountSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });

  it('SYS-R07 rejects other JSON types, and gives one message that holds no part of the value', () => {
    for (const value of [null, true, 1050n, ['1050'], { amount: '1050' }, undefined]) {
      expect(amountSchema.safeParse(value).success).toBe(false);
    }
    const result = amountSchema.safeParse('99999999999999999999');
    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]?.message).not.toContain('99999');
  });
});
