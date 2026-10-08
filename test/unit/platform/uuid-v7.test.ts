import { describe, expect, it } from 'vitest';
import { UuidV7Generator } from '../../../src/platform/ids/uuid-v7.js';

/** Canonical lowercase UUID with version 7 and the RFC 9562 variant. */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('UUIDv7 generator (spec 001 section 1.3)', () => {
  it('ACC-R01 generates 10000 valid UUIDv7 ids in a loop, each greater than the one before', () => {
    const ids = new UuidV7Generator();
    let previous = '';
    let invalid = 0;
    let unordered = 0;
    for (let i = 0; i < 10_000; i += 1) {
      const id = ids.next();
      if (!UUID_V7.test(id)) invalid += 1;
      // Lowercase hex in canonical form sorts as PostgreSQL's uuid order (byte order).
      if (id <= previous) unordered += 1;
      previous = id;
    }
    expect(invalid).toBe(0);
    expect(unordered).toBe(0);
  });

  it('ACC-R01 keeps the order across generator instances in one process', () => {
    const first = new UuidV7Generator().next();
    const second = new UuidV7Generator().next();
    expect(second > first).toBe(true);
  });
});
