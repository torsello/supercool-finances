import { describe, expect, it } from 'vitest';
import { currencySchema } from '../../../src/platform/http/schemas/currency.js';
import { parseUuid, uuidSchema } from '../../../src/platform/http/schemas/ids.js';

describe('the shared currency schema', () => {
  it('SYS-R08 SYS-R09 accepts exactly the codes of table 1.3 of spec 000, in upper case', () => {
    for (const code of ['USD', 'MXN', 'EUR', 'COP', 'JPY']) {
      expect(currencySchema.parse(code)).toBe(code);
    }
    for (const value of ['GBP', 'eur', 'Eur', '', ' EUR', 'EUR ', 'EURO', 978, null, undefined]) {
      expect(currencySchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });
});

describe('UUID parsing', () => {
  const lower = '0192f0a0-0000-7000-8000-0000000000c1';

  it('MOV-R30 parses a UUID in upper, lower or mixed case to its canonical lowercase form', () => {
    expect(parseUuid(lower)).toBe(lower);
    expect(parseUuid(lower.toUpperCase())).toBe(lower);
    expect(parseUuid('0192F0a0-0000-7000-8000-0000000000C1')).toBe(lower);
    expect(uuidSchema.parse(lower.toUpperCase())).toBe(lower);
  });

  it('SYS-R42 MOV-R30 finds no UUID in other text', () => {
    for (const value of [
      'not-a-uuid',
      '',
      `${lower} `,
      ` ${lower}`,
      `{${lower}}`,
      lower.replaceAll('-', ''),
      `${lower}0`,
      '0192f0a0-0000-7000-8000-0000000000cg',
    ]) {
      expect(parseUuid(value), value).toBeUndefined();
      expect(uuidSchema.safeParse(value).success, value).toBe(false);
    }
    expect(uuidSchema.safeParse(42).success).toBe(false);
  });
});
