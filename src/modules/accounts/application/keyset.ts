/**
 * A place in a newest-first list (section 1.5 of spec 001): `createdAt` as stored, an RFC 3339 UTC
 * string with microseconds such as `2026-10-07T12:00:01.000500Z`, and the item's canonical
 * lowercase `id`. In those fixed formats, text order is time order and PostgreSQL's `uuid` order.
 */
export interface Position {
  readonly createdAt: string;
  readonly id: string;
}

/** Newest first: the later `createdAt` first, then the greater `id` (ACC-R22). */
export function compareNewestFirst(a: Position, b: Position): number {
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1;
  if (a.id !== b.id) return a.id > b.id ? -1 : 1;
  return 0;
}

/**
 * True when `item` comes strictly after `position` in newest-first order, the SQL
 * `(created_at, id) < (position.createdAt, position.id)`: the next page starts there (ACC-R22).
 */
export function isAfter(item: Position, position: Position): boolean {
  return compareNewestFirst(item, position) > 0;
}

/** The position of an item, the last of a page, for the next page. */
export function positionOf(item: Position): Position {
  return { createdAt: item.createdAt, id: item.id };
}
