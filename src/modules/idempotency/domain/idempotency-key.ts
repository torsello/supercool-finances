/** The `Idempotency-Key` header as parsed at the malformed-request step (IDM-R03). */
export type ParsedIdempotencyKey =
  { kind: 'missing' } | { kind: 'malformed' } | { kind: 'key'; key: string };

/** 1 to 255 characters of visible ASCII, U+0021 to U+007E, space excluded (IDM-R03). */
const KEY = /^[\x21-\x7e]{1,255}$/;

/**
 * Parses the `Idempotency-Key` header: `missing` when absent, `malformed` when sent twice, empty,
 * above 255 characters or not visible ASCII, otherwise the key exactly as sent, never trimmed or
 * case-folded (IDM-R03, IDM-R04). A header sent twice arrives joined with ", " in Node's
 * `headers`, which the space makes malformed, or as a list of two in `headersDistinct`.
 */
export function parseIdempotencyKey(
  header: string | readonly string[] | undefined,
): ParsedIdempotencyKey {
  if (header === undefined) return { kind: 'missing' };
  if (typeof header !== 'string') {
    if (header.length === 0) return { kind: 'missing' };
    if (header.length > 1) return { kind: 'malformed' };
    return parseIdempotencyKey(header[0]);
  }
  return KEY.test(header) ? { kind: 'key', key: header } : { kind: 'malformed' };
}
