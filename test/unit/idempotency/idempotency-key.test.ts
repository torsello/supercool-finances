import { describe, expect, it } from 'vitest';
import { parseIdempotencyKey } from '../../../src/modules/idempotency/index.js';

describe('Idempotency-Key header parser', () => {
  it('IDM-AC02 accepts visible ASCII keys of 1 to 255 characters as sent, reports an absent header as missing and rejects every other value as malformed', () => {
    for (const key of ['k', 'k1', '018f2a00-0000-7000-8000-00000000000a', '!~', 'x'.repeat(255)]) {
      expect(parseIdempotencyKey(key)).toEqual({ kind: 'key', key });
    }

    expect(parseIdempotencyKey(undefined)).toEqual({ kind: 'missing' });

    for (const value of [
      '',
      'x'.repeat(256),
      'a b',
      ' k1',
      'k1 ',
      'clé',
      'k\t1',
      'k\u007f1',
      // Node joins a header sent twice with ", " in `headers`, and keeps both in `headersDistinct`.
      'k1, k2',
      ['k1', 'k2'],
    ]) {
      expect(parseIdempotencyKey(value)).toEqual({ kind: 'malformed' });
    }
  });

  it('IDM-R03 takes a header sent once as a one-element list like the string itself', () => {
    expect(parseIdempotencyKey(['k1'])).toEqual({ kind: 'key', key: 'k1' });
    expect(parseIdempotencyKey([])).toEqual({ kind: 'missing' });
  });
});
