import { createHash } from 'node:crypto';

/**
 * A value in the JSON Canonicalization Scheme of RFC 8785: object members sorted by the UTF-16
 * code units of their names at every level, arrays in order, no whitespace, and the string and
 * number serialization of ECMAScript's `JSON.stringify`, which is the one RFC 8785 specifies
 * (minimal escapes, `\u00xx` in lowercase hex for the other control characters, the shortest
 * round-trip number, `-0` as `0`). A value JSON cannot hold (`undefined`, a function, a bigint, a
 * non-finite number) is refused with a `TypeError` rather than silently dropped.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('not a JSON number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const members = Object.entries(value as Record<string, unknown>);
    // `<` compares strings by UTF-16 code units, as RFC 8785 section 3.2.3 requires.
    members.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${members.map(([name, item]) => `${JSON.stringify(name)}:${canonicalJson(item)}`).join(',')}}`;
  }
  throw new TypeError(`not a JSON value: ${typeof value}`);
}

/**
 * The fingerprint of a request (IDM-R05): the SHA-256 of the UTF-8 bytes of its method, a line
 * feed, its path as received without the query string and without normalization, a line feed,
 * and its body in canonical JSON, as 64 lowercase hex characters.
 */
export function fingerprint(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method}\n${path}\n${canonicalJson(body)}`, 'utf8')
    .digest('hex');
}
