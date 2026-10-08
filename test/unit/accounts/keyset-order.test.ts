import { describe, expect, it } from 'vitest';
import {
  compareNewestFirst,
  isAfter,
  positionOf,
  type Position,
} from '../../../src/modules/accounts/application/keyset.js';

function id(suffix: string): string {
  return `0192f0c4-0000-7000-8000-00000000${suffix}`;
}

const SAME_INSTANT = '2026-10-07T12:00:00.000000Z';
const ITEMS: Position[] = [
  { id: id('0001'), createdAt: SAME_INSTANT },
  { id: id('0003'), createdAt: SAME_INSTANT },
  { id: id('0002'), createdAt: SAME_INSTANT },
  { id: id('0007'), createdAt: '2026-10-07T11:59:59.999999Z' },
  // 0.4 ms apart within one millisecond: the API shows both as 12:00:01.000Z.
  { id: id('0009'), createdAt: '2026-10-07T12:00:01.000100Z' },
  { id: id('0004'), createdAt: '2026-10-07T12:00:01.000500Z' },
];
const NEWEST_FIRST = ['0004', '0009', '0003', '0002', '0001', '0007'].map(id);

describe('keyset order (spec 001 section 1.5)', () => {
  it('ACC-R22 orders positions newest first by microsecond createdAt, then id', () => {
    expect(ITEMS.toSorted(compareNewestFirst).map((item) => item.id)).toEqual(NEWEST_FIRST);
  });

  it('ACC-R22 "strictly after" a position resumes at the next position, never repeating or skipping one', () => {
    const ordered = ITEMS.toSorted(compareNewestFirst);
    ordered.forEach((item, index) => {
      const rest = ITEMS.filter((other) => isAfter(other, positionOf(item))).toSorted(
        compareNewestFirst,
      );
      expect(rest.map((other) => other.id)).toEqual(NEWEST_FIRST.slice(index + 1));
    });
  });

  it('ACC-R22 tells apart two positions in one millisecond by their microseconds', () => {
    const [newer, older] = ITEMS.filter((item) => item.createdAt.startsWith('2026-10-07T12:00:01'))
      .toSorted(compareNewestFirst)
      .map(positionOf);
    if (newer === undefined || older === undefined) throw new Error('fixture lost its pair');
    expect(isAfter(older, newer)).toBe(true);
    expect(isAfter(newer, older)).toBe(false);
    expect(isAfter(newer, newer)).toBe(false);
  });

  it('ACC-R22 keeps only createdAt and id in a position', () => {
    expect(positionOf({ ...ITEMS[0], status: 'active' } as Position)).toEqual(ITEMS[0]);
  });
});
