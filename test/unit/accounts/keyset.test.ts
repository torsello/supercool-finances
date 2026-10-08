import { describe, expect, it } from 'vitest';
import { CursorCodec } from '../../../src/modules/accounts/adapters/http/cursor.js';
import { apiTimestamp } from '../../../src/platform/http/timestamp.js';
import {
  compareNewestFirst,
  isAfter,
  positionOf,
  type Position,
} from '../../../src/modules/accounts/index.js';

const id = (suffix: string): string => `00000000-0000-7000-8000-00000000${suffix.padStart(4, '0')}`;

const C1 = '0192f0a0-0000-7000-8000-0000000000c1';
const A1 = '0192f0a0-0000-7000-8000-0000000000a1';
const scope = { list: 'entries', userId: C1, accountId: A1 } as const;
const codec = new CursorCodec('test-only-cursor-secret-for-the-keyset-unit-tests');

/**
 * One page by the keyset rule of plan 001 section 3.4, in memory: newest first, strictly after the
 * cursor's position, `limit + 1` rows read to decide whether a next cursor is issued.
 */
function page(entries: readonly Position[], limit: number, cursor?: string) {
  const after = cursor === undefined ? undefined : codec.decode(cursor, scope);
  const rows = [...entries]
    .sort(compareNewestFirst)
    .filter((entry) => after === undefined || isAfter(entry, after))
    .slice(0, limit + 1);
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  const next =
    rows.length > limit && last !== undefined ? codec.encode(scope, positionOf(last)) : undefined;
  return { items, next };
}

describe('keyset paging with real cursors', () => {
  it('ACC-AC20 keeps a fixed order for entries recorded at the same instant, and pages of 1 neither repeat nor skip one', () => {
    const sameInstant = '2026-10-07T12:00:00.000000Z';
    const older = { id: id('0005'), createdAt: '2026-10-07T11:59:59.999999Z' };
    const e9 = { id: id('0009'), createdAt: '2026-10-07T12:00:01.000100Z' };
    const e4 = { id: id('0004'), createdAt: '2026-10-07T12:00:01.000500Z' };
    const entries = [
      { id: id('0001'), createdAt: sameInstant },
      { id: id('0003'), createdAt: sameInstant },
      { id: id('0002'), createdAt: sameInstant },
      older,
      e9,
      e4,
    ];

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < 10; pages += 1) {
      const result = page(entries, 1, cursor);
      expect(result.items).toHaveLength(1);
      seen.push(result.items[0]?.id ?? '');
      cursor = result.next;
      if (cursor === undefined) break;
    }

    expect(seen).toEqual([id('0004'), id('0009'), id('0003'), id('0002'), id('0001'), older.id]);
    expect(new Set(seen).size).toBe(entries.length);
    expect(cursor).toBeUndefined();
    // Both show 12:00:01.000 in the API, yet their cursors keep them apart.
    expect(apiTimestamp(e4.createdAt)).toBe('2026-10-07T12:00:01.000Z');
    expect(apiTimestamp(e9.createdAt)).toBe(apiTimestamp(e4.createdAt));
  });
});
