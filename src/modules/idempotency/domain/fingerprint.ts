import { createHash } from 'node:crypto';

/** The deepest nesting of arrays and objects a canonical body may have (IDM-R05). */
export const MAX_DEPTH = 64;

/**
 * Stands in for the canonical JSON of a body RFC 8785 cannot encode (IDM-R05). No canonical JSON
 * starts with `!`, so it is the canonical JSON of no value and no other body shares its fingerprint.
 */
export const NOT_CANONICAL_MARKER = '!not-canonical-json';

/**
 * A value in the JSON Canonicalization Scheme of RFC 8785: object members sorted by the UTF-16
 * code units of their names at every level, arrays in order, no whitespace, and the string and
 * number serialization of ECMAScript's `JSON.stringify`, which is the one RFC 8785 specifies
 * (minimal escapes, `\u00xx` in lowercase hex for the other control characters, the shortest
 * round-trip number, `-0` as `0`). A value JSON cannot hold (`undefined`, a function, a bigint, a
 * non-finite number such as the `Infinity` that `JSON.parse` makes of `1e400`) is refused with a
 * `TypeError` rather than silently dropped, and so is nesting deeper than `MAX_DEPTH` levels,
 * before recursing any further.
 */
export function canonicalJson(value: unknown): string {
  return canonical(value, 0);
}

/** `value` inside `depth` arrays or objects. */
function canonical(value: unknown, depth: number): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('not a JSON number');
    return JSON.stringify(value);
  }
  if (typeof value === 'object' && depth >= MAX_DEPTH) {
    throw new TypeError(`nested deeper than ${String(MAX_DEPTH)} levels`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => canonical(item, depth + 1)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const members = Object.entries(value as Record<string, unknown>);
    // `<` compares strings by UTF-16 code units, as RFC 8785 section 3.2.3 requires.
    members.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${members.map(([name, item]) => `${JSON.stringify(name)}:${canonical(item, depth + 1)}`).join(',')}}`;
  }
  throw new TypeError(`not a JSON value: ${typeof value}`);
}

/** The canonical JSON of a body, or the marker when RFC 8785 cannot encode it (IDM-R05). */
function canonicalBody(body: unknown): string {
  try {
    return canonicalJson(body);
  } catch (error) {
    if (error instanceof TypeError) return NOT_CANONICAL_MARKER;
    throw error;
  }
}

/**
 * The fingerprint of a request (IDM-R05): the SHA-256 of the UTF-8 bytes of its method, a line
 * feed, its path as received without the query string and without normalization, a line feed,
 * and its body in canonical JSON, or `NOT_CANONICAL_MARKER` for a body RFC 8785 cannot encode, as
 * 64 lowercase hex characters. It never throws for a parsed body: such a body never passes
 * validation, so its outcome is never stored.
 */
export function fingerprint(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method}\n${path}\n${canonicalBody(body)}`, 'utf8')
    .digest('hex');
}
