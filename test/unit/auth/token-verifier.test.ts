import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyToken } from '../../../src/modules/auth/application/token-verifier.js';
import { Unauthenticated } from '../../../src/modules/auth/domain/errors.js';
import { toProblem } from '../../../src/platform/http/error-handler.js';
import {
  base64urlJson,
  C1,
  K2,
  K3,
  O1,
  referenceClaims,
  referenceToken,
  segments,
  signToken,
  T,
  TEST_JWT,
  variantClaims,
  variantToken,
  type Claims,
  type Header,
} from '../../support/tokens.js';

async function verify(token: string, now: number = T) {
  return await verifyToken(token, TEST_JWT, now);
}

/**
 * The internal reason of the rejection, after checking that the error is the one type the HTTP
 * edge maps to 401 `/problems/unauthenticated`; fails the test when the token is accepted.
 */
async function reasonOf(token: string, now: number = T): Promise<string> {
  try {
    await verify(token, now);
  } catch (error) {
    if (!(error instanceof Unauthenticated)) throw error;
    expect(toProblem(error)).toMatchObject({ status: 401, type: '/problems/unauthenticated' });
    return error.reason;
  }
  throw new Error('the token was accepted');
}

/** A compact JWS with `header` and `claims`, signed with an asymmetric private key. */
function signAsymmetric(header: Header, claims: Claims, key: KeyObject, ecdsa: boolean): string {
  const signingInput = `${base64urlJson(header)}.${base64urlJson(claims)}`;
  const signature = sign(
    'sha256',
    Buffer.from(signingInput),
    ecdsa ? { key, dsaEncoding: 'ieee-p1363' } : key,
  );
  return `${signingInput}.${signature.toString('base64url')}`;
}

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * The token with the last character of its signature changed to one that differs in its high
 * bits, so the decoded signature changes too, whatever the decoder does with the unused low bits.
 */
function withLastCharacterChanged(token: string): string {
  const index = BASE64URL.indexOf(token.at(-1) ?? '');
  return `${token.slice(0, -1)}${BASE64URL[index ^ 32] ?? 'A'}`;
}

describe('token verifier: header, signature and claims', () => {
  it('AUT-AC01 identifies the caller of V, of an operator variant, of an uppercase sub, of an aud array and of extra claims and kid', async () => {
    await expect(verify(referenceToken())).resolves.toEqual({ userId: C1, role: 'customer' });
    await expect(verify(variantToken({ sub: O1, role: 'operator' }))).resolves.toEqual({
      userId: O1,
      role: 'operator',
    });
    await expect(
      verify(variantToken({ sub: '0192F0A0-0000-7000-8000-0000000000C1' })),
    ).resolves.toEqual({ userId: C1, role: 'customer' });
    await expect(verify(variantToken({ aud: ['other-api', 'scf-api'] }))).resolves.toEqual({
      userId: C1,
      role: 'customer',
    });
    await expect(
      verify(variantToken({ name: 'Alice' }, { header: { alg: 'HS256', typ: 'JWT', kid: 'k1' } })),
    ).resolves.toEqual({ userId: C1, role: 'customer' });
  });

  it('AUT-AC05 rejects a wrong issuer, audience, role or subject with reason claims, answered 401', async () => {
    for (const changes of [
      { iss: 'other' },
      { iss: undefined },
      { aud: 'other' },
      { aud: ['other'] },
      { aud: undefined },
      { role: 'admin' },
      { role: 'Customer' },
      { role: '' },
      { role: ['customer'] },
      { role: undefined },
      { sub: '' },
      { sub: 'not-a-uuid' },
      { sub: 123 },
      { sub: undefined },
    ]) {
      expect(await reasonOf(variantToken(changes)), JSON.stringify(changes)).toBe('claims');
    }
  });

  it('AUT-R03 rejects missing or non-numeric iat and exp, and a non-numeric nbf, with reason claims', async () => {
    for (const changes of [
      { exp: undefined },
      { iat: undefined },
      { exp: '1791375240' },
      { iat: String(T - 60) },
      { nbf: 'soon' },
    ]) {
      expect(await reasonOf(variantToken(changes)), JSON.stringify(changes)).toBe('claims');
    }
  });

  it('AUT-R02 rejects a header that is not a JSON object, and a token that is not three segments, with reason malformed', async () => {
    const [, payload, signature] = segments(referenceToken());
    for (const token of [
      `${Buffer.from('not json').toString('base64url')}.${payload}.${signature}`,
      `${base64urlJson(['HS256'])}.${payload}.${signature}`,
      `${base64urlJson(null)}.${payload}.${signature}`,
      `e30$.${payload}.${signature}`,
      `${payload}.${signature}`,
      'abc.def',
      '',
    ]) {
      expect(await reasonOf(token), token).toBe('malformed');
    }
  });

  it('AUT-R02 rejects a correctly signed payload that is not a JSON object with reason malformed', async () => {
    for (const claims of [['sub'], 'customer', 42, null]) {
      expect(await reasonOf(signToken(claims as unknown as Claims)), JSON.stringify(claims)).toBe(
        'malformed',
      );
    }
  });
});

describe('token verifier: expiry, not-before and lifetime', () => {
  it('AUT-AC03 checks expiry, not-before and lifetime with a 5-second tolerance, each rejection answered 401', async () => {
    for (const changes of [
      { iat: T - 600, exp: T - 4 },
      { iat: T + 5, exp: T + 600 },
      { nbf: T + 5 },
      { iat: T, exp: T + 900 },
    ]) {
      await expect(verify(variantToken(changes)), JSON.stringify(changes)).resolves.toEqual({
        userId: C1,
        role: 'customer',
      });
    }
    const rejected: [Claims, string][] = [
      [{ iat: T - 600, exp: T - 5 }, 'expired'],
      [{ iat: T + 6, exp: T + 600 }, 'not_yet_valid'],
      [{ nbf: T + 6 }, 'not_yet_valid'],
      [{ iat: T, exp: T + 901 }, 'lifetime'],
      [{ iat: T, exp: T }, 'lifetime'],
      [{ exp: undefined }, 'claims'],
      [{ iat: undefined }, 'claims'],
      [{ exp: '1791375240' }, 'claims'],
    ];
    for (const [changes, reason] of rejected) {
      expect(await reasonOf(variantToken(changes)), JSON.stringify(changes)).toBe(reason);
    }
  });

  it('AUT-R05 rejects an exp before iat with reason lifetime', async () => {
    expect(await reasonOf(variantToken({ iat: T + 2, exp: T + 1 }))).toBe('lifetime');
  });

  it('AUT-R04 reads the time from the injected clock, not the real one', async () => {
    const v = referenceToken();
    await expect(verify(v, T + 844)).resolves.toEqual({ userId: C1, role: 'customer' });
    expect(await reasonOf(v, T + 845)).toBe('expired');
    expect(await reasonOf(v, T - 66)).toBe('not_yet_valid');
  });
});

describe('token verifier: signature and algorithm', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const p256 = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const claims = referenceClaims();

  it('AUT-AC04 accepts only HS256 signed with the configured secret, each rejection answered 401 with reason signature or algorithm', async () => {
    const v = referenceToken();
    const [header, payload, signature] = segments(v);
    const operatorPayload = base64urlJson(variantClaims({ role: 'operator' }));
    const noneHeader = base64urlJson({ alg: 'none', typ: 'JWT' });
    const jwk = { kty: 'oct', k: Buffer.from(K3, 'utf8').toString('base64url') };
    const jwe = [
      base64urlJson({ alg: 'dir', enc: 'A256GCM' }),
      '',
      Buffer.from('initialization').toString('base64url'),
      Buffer.from('ciphertext').toString('base64url'),
      Buffer.from('tag').toString('base64url'),
    ].join('.');
    const tokens: Record<string, [string, 'signature' | 'algorithm']> = {
      'signed with K2': [signToken(claims, { secret: K2 }), 'signature'],
      'last signature character changed': [withLastCharacterChanged(v), 'signature'],
      'payload replaced': [`${header}.${operatorPayload}.${signature}`, 'signature'],
      'none, empty signature': [`${noneHeader}.${payload}.`, 'algorithm'],
      "none, V's signature": [`${noneHeader}.${payload}.${signature}`, 'algorithm'],
      None: [signToken(claims, { header: { alg: 'None', typ: 'JWT' } }), 'algorithm'],
      hs256: [
        signToken(claims, { header: { alg: 'hs256', typ: 'JWT' }, hmac: 'HS256' }),
        'algorithm',
      ],
      HS384: [signToken(claims, { header: { alg: 'HS384', typ: 'JWT' } }), 'algorithm'],
      HS512: [signToken(claims, { header: { alg: 'HS512', typ: 'JWT' } }), 'algorithm'],
      RS256: [
        signAsymmetric({ alg: 'RS256', typ: 'JWT' }, claims, rsa.privateKey, false),
        'algorithm',
      ],
      ES256: [
        signAsymmetric({ alg: 'ES256', typ: 'JWT' }, claims, p256.privateKey, true),
        'algorithm',
      ],
      // A key embedded in the header is never used, so K3 fails as a wrong signature.
      'K3 in a jwk header': [
        signToken(claims, { header: { alg: 'HS256', typ: 'JWT', jwk }, secret: K3 }),
        'signature',
      ],
      crit: [
        signToken(claims, {
          header: { alg: 'HS256', typ: 'JWT', crit: ['x-ext'], 'x-ext': true },
        }),
        'algorithm',
      ],
      'five-segment JWE': [jwe, 'algorithm'],
    };
    for (const [name, [token, reason]] of Object.entries(tokens)) {
      expect(await reasonOf(token), name).toBe(reason);
    }
    await expect(verify(v)).resolves.toEqual({ userId: C1, role: 'customer' });
  });
});
