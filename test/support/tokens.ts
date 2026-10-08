import { createHmac } from 'node:crypto';
import type { JwtConfig } from '../../src/platform/config/config.js';

/**
 * Tokens for unit and integration tests (section 3 of spec 006): the reference token V and its
 * variants, signed with the test secret K. Signing is done here with `node:crypto`, not with the
 * code under test, so a test can build any header, including ones `jose` refuses to sign.
 */

/** K, the 48-byte test value of `JWT_SECRET`. */
export const K = 'test-only-jwt-secret-K-for-unit-and-integration-';
/** K2, another 48-byte value. */
export const K2 = 'test-only-jwt-secret-K2-a-different-48-byte-key-';
/** K3, a third 48-byte value, for the embedded-key case of AUT-AC04. */
export const K3 = 'test-only-jwt-secret-K3-embedded-in-a-jwk-header';

export const TEST_ISSUER = 'scf-test';
export const TEST_AUDIENCE = 'scf-api';

/** The token settings every test app runs with. */
export const TEST_JWT: JwtConfig = { secret: K, issuer: TEST_ISSUER, audience: TEST_AUDIENCE };

/** The fixed users of the unit ACs and AUT-AC12. */
export const C1 = '0192f0a0-0000-7000-8000-0000000000c1';
export const C2 = '0192f0a0-0000-7000-8000-0000000000c2';
export const O1 = '0192f0a0-0000-7000-8000-0000000000f1';

/** T, the verifier's clock in the unit ACs: 2026-10-07T12:00:00Z, in seconds. */
export const T = 1791374400;

export type Claims = Record<string, unknown>;
export type Header = Record<string, unknown>;

export const STANDARD_HEADER: Header = { alg: 'HS256', typ: 'JWT' };

/** The claims of V, issued at `now` − 60 and expiring at `now` + 840. */
export function referenceClaims(now: number = T): Claims {
  return {
    sub: C1,
    role: 'customer',
    iat: now - 60,
    exp: now + 840,
    iss: TEST_ISSUER,
    aud: TEST_AUDIENCE,
  };
}

/** Claims of V with `changes` applied; a change to `undefined` removes the claim. */
export function variantClaims(changes: Claims, now: number = T): Claims {
  const claims: Claims = { ...referenceClaims(now), ...changes };
  for (const [name, value] of Object.entries(changes)) {
    if (value === undefined) Reflect.deleteProperty(claims, name);
  }
  return claims;
}

export function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

const HMAC_HASHES: Readonly<Record<string, string>> = {
  HS256: 'sha256',
  HS384: 'sha384',
  HS512: 'sha512',
};

/**
 * A compact JWS with `header` and `claims`, signed by HMAC with `secret`: the hash follows
 * `options.hmac`, or the header's `alg` when it names an HMAC algorithm, else SHA-256.
 */
export function signToken(
  claims: Claims,
  options: { header?: Header; secret?: string; hmac?: 'HS256' | 'HS384' | 'HS512' } = {},
): string {
  const header = options.header ?? STANDARD_HEADER;
  const signingInput = `${base64urlJson(header)}.${base64urlJson(claims)}`;
  const alg = options.hmac ?? (typeof header['alg'] === 'string' ? header['alg'] : 'HS256');
  const hash = HMAC_HASHES[alg] ?? 'sha256';
  const signature = createHmac(hash, options.secret ?? K)
    .update(signingInput)
    .digest('base64url');
  return `${signingInput}.${signature}`;
}

/** V: the reference token of section 3 of spec 006, at clock `now`. */
export function referenceToken(now: number = T): string {
  return signToken(referenceClaims(now));
}

/** A variant of V: V's claims with `changes`, signed with K unless options say otherwise. */
export function variantToken(
  changes: Claims,
  options: { header?: Header; secret?: string; now?: number } = {},
): string {
  return signToken(variantClaims(changes, options.now), options);
}

/** The current time in whole seconds, as integration ACs take T. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** A valid token for `sub` with `role`, shaped like V with T the current time. */
export function tokenFor(sub: string, role: 'customer' | 'operator'): string {
  return variantToken({ sub, role }, { now: nowSeconds() });
}

/** The three segments of a compact token. */
export function segments(token: string): [string, string, string] {
  const [header = '', payload = '', signature = ''] = token.split('.');
  return [header, payload, signature];
}

/** The decoded header and claims of a compact token. */
export function decodeToken(token: string): { header: unknown; claims: unknown } {
  const [header, payload] = segments(token);
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as unknown,
    claims: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown,
  };
}
