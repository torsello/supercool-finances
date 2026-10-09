import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listen } from '../../../src/app.js';
import { buildProductionApp, testConfig, type BuiltApp } from '../../support/app.js';
import {
  balanceOf,
  closePools,
  createCustomerAccount,
  writeDirectDeposit,
} from '../../support/db.js';
import { bearer, freshKey, problemOf } from '../../support/http.js';
import { freePort } from '../../support/ports.js';
import {
  base64urlJson,
  K2,
  nowSeconds,
  referenceClaims,
  signToken,
  tokenFor,
  variantClaims,
  variantToken,
} from '../../support/tokens.js';

/** A compact JWS signed with RS256 by a key of its own. */
function rs256Token(claims: Record<string, unknown>): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const input = `${base64urlJson({ alg: 'RS256', typ: 'JWT' })}.${base64urlJson(claims)}`;
  return `${input}.${sign('sha256', Buffer.from(input), privateKey).toString('base64url')}`;
}

describe('requests without valid credentials', () => {
  let built: BuiltApp;
  let port: number;
  let metricsPort: number;

  beforeAll(async () => {
    port = await freePort();
    metricsPort = await freePort();
    const env = { PORT: String(port), METRICS_PORT: String(metricsPort) };
    built = buildProductionApp({ env });
    await listen(built.app, testConfig(env), '127.0.0.1');
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('SYS-AC02 every request without valid credentials answers 401 and changes nothing; health, metrics and unknown paths answer without them', async () => {
    const c1Id = randomUUID();
    const a1 = await createCustomerAccount({ currency: 'EUR', ownerId: c1Id });
    await writeDirectDeposit(a1, '10000');
    const t = nowSeconds();
    const claims = { ...referenceClaims(t), sub: c1Id };

    const credentials: [string, Record<string, string>][] = [
      ['no credentials', {}],
      ['expired', bearer(variantToken({ sub: c1Id, iat: t - 600, exp: t - 60 }, { now: t }))],
      ['a signature that does not verify', bearer(signToken(claims, { secret: K2 }))],
      [
        'alg none',
        bearer(`${base64urlJson({ alg: 'none', typ: 'JWT' })}.${base64urlJson(claims)}.`),
      ],
      ['no role', bearer(signToken(variantClaims({ sub: c1Id, role: undefined }, t)))],
      ['role admin', bearer(signToken(variantClaims({ sub: c1Id, role: 'admin' }, t)))],
      ['no exp', bearer(signToken(variantClaims({ sub: c1Id, exp: undefined }, t)))],
      ['no sub', bearer(signToken(variantClaims({ sub: undefined }, t)))],
      ['HS512', bearer(signToken(claims, { header: { alg: 'HS512', typ: 'JWT' }, hmac: 'HS512' }))],
      ['RS256', bearer(rs256Token(claims))],
    ];
    for (const [label, headers] of credentials) {
      const read = await built.app.inject({ method: 'GET', url: `/v1/accounts/${a1.id}`, headers });
      const withdrawal = await built.app.inject({
        method: 'POST',
        url: `/v1/accounts/${a1.id}/withdrawals`,
        headers: { ...headers, 'idempotency-key': freshKey() },
        payload: { amount: '100', currency: 'EUR' },
      });
      for (const response of [read, withdrawal]) {
        expect(response.statusCode, label).toBe(401);
        expect(problemOf(response).type, label).toBe('/problems/unauthenticated');
      }
    }
    expect(await balanceOf(a1.id)).toBe('10000');

    expect((await built.app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
    expect((await fetch(`http://127.0.0.1:${String(metricsPort)}/metrics`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${String(port)}/metrics`)).status).toBe(404);
    for (const headers of [{}, bearer(tokenFor(c1Id, 'customer'))]) {
      const unknown = await built.app.inject({ method: 'GET', url: '/no-such-path', headers });
      expect(unknown.statusCode).toBe(404);
      expect(problemOf(unknown).type).toBe('/problems/not-found');
    }
  });
});
