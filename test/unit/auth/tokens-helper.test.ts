import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  C1,
  decodeToken,
  K,
  K2,
  K3,
  referenceToken,
  segments,
  T,
  variantToken,
} from '../../support/tokens.js';

describe('the token test helper', () => {
  it('AUT-R02 AUT-R03 signs V with the header and claims of section 3 of spec 006, with K', () => {
    const v = referenceToken();
    expect(decodeToken(v)).toEqual({
      header: { alg: 'HS256', typ: 'JWT' },
      claims: {
        sub: C1,
        role: 'customer',
        iat: T - 60,
        exp: T + 840,
        iss: 'scf-test',
        aud: 'scf-api',
      },
    });
    const [header, payload, signature] = segments(v);
    expect(signature).toBe(
      createHmac('sha256', K).update(`${header}.${payload}`).digest('base64url'),
    );
  });

  it('AUT-R02 AUT-R03 changes only what a variant names, removes claims set to undefined, and signs with the given secret', () => {
    const variant = variantToken({ role: 'operator', exp: undefined }, { secret: K2 });
    const { claims } = decodeToken(variant);
    expect(claims).toEqual({
      sub: C1,
      role: 'operator',
      iat: T - 60,
      iss: 'scf-test',
      aud: 'scf-api',
    });
    const [header, payload, signature] = segments(variant);
    expect(signature).toBe(
      createHmac('sha256', K2).update(`${header}.${payload}`).digest('base64url'),
    );
  });

  it('AUT-R02 uses 48-byte secrets that differ', () => {
    for (const secret of [K, K2, K3]) expect(Buffer.byteLength(secret, 'utf8')).toBe(48);
    expect(new Set([K, K2, K3]).size).toBe(3);
  });
});
