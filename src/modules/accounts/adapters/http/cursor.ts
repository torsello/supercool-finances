import { createHmac, timingSafeEqual } from 'node:crypto';
import { MalformedRequest } from '../../../../platform/http/errors.js';
import type { Position } from '../../application/keyset.js';

/** The list a cursor belongs to, and whom and which account it was issued for (ACC-R23). */
export type CursorScope =
  { list: 'accounts'; userId: string } | { list: 'entries'; userId: string; accountId: string };

/** The bytes of an HMAC-SHA256 tag. */
const TAG_BYTES = 32;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MICROSECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The cursor of plan 001 section 5: `base64url(payload ‖ tag)`, where `payload` is the UTF-8 JSON
 * `{"l", "u", "a" (entries only), "t", "i"}` and `tag` its HMAC-SHA256 with `CURSOR_SECRET`, so
 * every replica with the same secret reads it (ACC-R30, ADR-0017). A cursor that fails any check is
 * `MalformedRequest`, answered 400 (ACC-R23).
 */
export class CursorCodec {
  readonly #secret: Buffer;

  constructor(secret: string) {
    this.#secret = Buffer.from(secret, 'utf8');
  }

  #tag(payload: Buffer): Buffer {
    return createHmac('sha256', this.#secret).update(payload).digest();
  }

  /** The cursor that resumes `scope` strictly after `position`. */
  encode(scope: CursorScope, position: Position): string {
    const payload = Buffer.from(
      JSON.stringify({
        l: scope.list,
        u: scope.userId,
        ...(scope.list === 'entries' ? { a: scope.accountId } : {}),
        t: position.createdAt,
        i: position.id,
      }),
      'utf8',
    );
    return Buffer.concat([payload, this.#tag(payload)]).toString('base64url');
  }

  /**
   * The position a cursor holds, after checking its encoding, length, tag (in constant time), shape,
   * and that it was issued for `scope`.
   */
  decode(text: string, scope: CursorScope): Position {
    if (!BASE64URL.test(text)) throw new MalformedRequest('cursor');
    const bytes = Buffer.from(text, 'base64url');
    // Only the canonical encoding is accepted: unused trailing bits must not change the meaning.
    if (bytes.toString('base64url') !== text || bytes.length <= TAG_BYTES) {
      throw new MalformedRequest('cursor');
    }
    const payload = bytes.subarray(0, bytes.length - TAG_BYTES);
    const tag = bytes.subarray(bytes.length - TAG_BYTES);
    if (!timingSafeEqual(tag, this.#tag(payload))) throw new MalformedRequest('cursor');

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.toString('utf8'));
    } catch {
      throw new MalformedRequest('cursor');
    }
    if (!isRecord(parsed)) throw new MalformedRequest('cursor');
    const expectedKeys =
      scope.list === 'entries' ? ['l', 'u', 'a', 't', 'i'] : ['l', 'u', 't', 'i'];
    const keys = Object.keys(parsed);
    const { l, u, a, t, i } = parsed;
    if (
      keys.length !== expectedKeys.length ||
      !expectedKeys.every((key) => keys.includes(key)) ||
      l !== scope.list ||
      u !== scope.userId ||
      (scope.list === 'entries' && a !== scope.accountId) ||
      typeof t !== 'string' ||
      !MICROSECONDS.test(t) ||
      typeof i !== 'string' ||
      !LOWERCASE_UUID.test(i)
    ) {
      throw new MalformedRequest('cursor');
    }
    return { createdAt: t, id: i };
  }
}
