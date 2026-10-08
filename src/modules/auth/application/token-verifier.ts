import { compactVerify } from 'jose';
import { isRole, type Caller } from '../domain/caller.js';
import { Unauthenticated } from '../domain/errors.js';

/** `JWT_SECRET`, `JWT_ISSUER` and `JWT_AUDIENCE` (section 1.4 of spec 006). */
export interface TokenSettings {
  /** Used as UTF-8 bytes, as given. */
  secret: string;
  issuer: string;
  audience: string;
}

/** The clock tolerance on `exp`, `iat` and `nbf`, fixed in code (section 1.1 of spec 006). */
const TOLERANCE_SECONDS = 5;
/** The longest lifetime, `exp` − `iat`, without tolerance (AUT-R05). */
const MAX_LIFETIME_SECONDS = 900;

const SEGMENT = /^[A-Za-z0-9_-]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The JSON object a base64url segment encodes, or `undefined`. */
function decodeSegment(segment: string | undefined): JsonObject | undefined {
  if (segment === undefined || segment === '' || !SEGMENT.test(segment)) return undefined;
  return parseObject(Buffer.from(segment, 'base64url'));
}

function parseObject(bytes: Uint8Array): JsonObject | undefined {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return isJsonObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isNumericDate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Check 1 of section 3 of plan 006: the protected header. A token that is not three segments is
 * `algorithm` when its header declares an encryption algorithm (a JWE), else `malformed`.
 */
function checkHeader(token: string): void {
  const segments = token.split('.');
  const header = decodeSegment(segments[0]);
  if (segments.length !== 3) {
    throw new Unauthenticated(
      header !== undefined && typeof header['enc'] === 'string' ? 'algorithm' : 'malformed',
    );
  }
  if (header === undefined) throw new Unauthenticated('malformed');
  // No extension is understood, so a crit parameter is refused (RFC 7515 section 4.1.11).
  if ('crit' in header || header['alg'] !== 'HS256') throw new Unauthenticated('algorithm');
}

/**
 * Check 2: the signature, with `JWT_SECRET` as a raw key passed directly, never a key resolver, so
 * no key named, embedded or fetched from the header (`kid`, `jwk`, `jku`, `x5u`, `x5c`) is used.
 */
async function checkSignature(token: string, secret: string): Promise<JsonObject> {
  let payload: Uint8Array;
  try {
    ({ payload } = await compactVerify(token, new TextEncoder().encode(secret), {
      algorithms: ['HS256'],
    }));
  } catch {
    throw new Unauthenticated('signature');
  }
  const claims = parseObject(payload);
  if (claims === undefined) throw new Unauthenticated('malformed');
  return claims;
}

function hasAudience(aud: unknown, audience: string): boolean {
  return aud === audience || (Array.isArray(aud) && aud.includes(audience));
}

/**
 * Verifies a compact JWS from the token, the settings and the clock alone, with no state between
 * calls (AUT-R21), in the order of section 3 of plan 006, so each failure has its own reason
 * (AUT-R19). `now` is in seconds since the epoch. `jose` checks only the signature: its JWT
 * helpers would check `exp` and `nbf` against the real clock before these checks could run.
 */
export async function verifyToken(
  token: string,
  settings: TokenSettings,
  now: number,
): Promise<Caller> {
  checkHeader(token);
  const claims = await checkSignature(token, settings.secret);

  const { sub, role, iat, exp, nbf, iss, aud } = claims;
  if (
    typeof sub !== 'string' ||
    !UUID.test(sub) ||
    !isRole(role) ||
    !isNumericDate(iat) ||
    !isNumericDate(exp) ||
    (nbf !== undefined && !isNumericDate(nbf)) ||
    iss !== settings.issuer ||
    !hasAudience(aud, settings.audience)
  ) {
    throw new Unauthenticated('claims');
  }
  if (!(now < exp + TOLERANCE_SECONDS)) throw new Unauthenticated('expired');
  if (iat > now + TOLERANCE_SECONDS || (nbf !== undefined && nbf > now + TOLERANCE_SECONDS)) {
    throw new Unauthenticated('not_yet_valid');
  }
  const lifetime = exp - iat;
  if (!(lifetime > 0 && lifetime <= MAX_LIFETIME_SECONDS)) throw new Unauthenticated('lifetime');

  return { userId: sub.toLowerCase(), role };
}
