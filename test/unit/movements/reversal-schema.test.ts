import { describe, expect, it } from 'vitest';
import { reversalBody } from '../../../src/modules/movements/adapters/http/schemas.js';
import { ValidationFailed } from '../../../src/platform/http/errors.js';
import { parseBody } from '../../../src/platform/http/validation.js';

function errorsOf(body: unknown) {
  try {
    parseBody(reversalBody, body);
    return undefined;
  } catch (error) {
    if (!(error instanceof ValidationFailed)) throw error;
    return error.errors;
  }
}

describe('the reversal body schema', () => {
  it('REV-AC16 accepts a reason of 3 to 500 code points unchanged, and refuses every other body with exactly one errors entry', () => {
    for (const reason of [
      'abc',
      '  a',
      'Duplicate deposit from rail',
      'é'.repeat(500),
      '👍'.repeat(500),
    ]) {
      expect(parseBody(reversalBody, { reason }), reason.slice(0, 10)).toEqual({ reason });
    }
    expect('👍'.repeat(500)).toHaveLength(1000);

    for (const body of [
      {},
      { reason: '' },
      { reason: 'ab' },
      { reason: '   ' },
      { reason: 'a'.repeat(501) },
      { reason: '👍👍' },
      { reason: 'a\u0000bc' },
      { reason: 'line one\nline two' },
      { reason: 'abc\u007f' },
      { reason: 42 },
      { reason: null },
    ]) {
      expect(errorsOf(body), JSON.stringify(body)).toEqual([
        { pointer: '/reason', detail: expect.any(String) as string },
      ]);
    }
    expect('👍👍').toHaveLength(4);
    expect(errorsOf({ reason: 'abc', amount: '5' })).toEqual([
      { pointer: '/amount', detail: expect.any(String) as string },
    ]);
  });

  it('REV-R14 a refused reason never appears in the detail of its entry', () => {
    const errors = errorsOf({ reason: 'secret fraud note\n' });
    expect(JSON.stringify(errors)).not.toContain('secret');
  });
});
