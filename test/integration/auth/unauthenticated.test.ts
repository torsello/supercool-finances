import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { balanceOf, closePools, runtimePool } from '../../support/db.js';
import { createAccount, deposit, problemOf, withoutRequestId } from '../../support/http.js';
import {
  C1,
  K2,
  base64urlJson,
  nowSeconds,
  referenceClaims,
  referenceToken,
  segments,
  signToken,
  tokenFor,
  variantToken,
} from '../../support/tokens.js';

describe('requests without a valid token (AUT-R01, AUT-R02, AUT-R06, AUT-R20)', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('AUT-AC02 answers every request without a valid token with the same 401, and serves the health check and the docs either way', async () => {
    const t = nowSeconds();
    const a1 = await createAccount(built.app, tokenFor(C1, 'customer'));
    expect(
      (await deposit(built.app, tokenFor(randomUUID(), 'operator'), a1.id, '10000')).statusCode,
    ).toBe(201);

    const v = referenceToken(t);
    const [vHeader, , vSignature] = segments(v);
    const expired = variantToken({ exp: t - 60, iat: t - 600 }, { now: t });
    const variants: [string, Record<string, string>, string][] = [
      ['no Authorization header', {}, ''],
      ['Basic credentials', { authorization: 'Basic dXNlcjpwYXNz' }, ''],
      ['Bearer without a token', { authorization: 'Bearer' }, ''],
      ['Bearer abc.def', { authorization: 'Bearer abc.def' }, ''],
      [
        'a payload that is not base64url JSON',
        { authorization: `Bearer ${vHeader}.bm90IGpzb24.${vSignature}` },
        '',
      ],
      ['V in the query string', {}, `?access_token=${v}`],
      ['expired', { authorization: `Bearer ${expired}` }, ''],
      [
        'not yet valid',
        { authorization: `Bearer ${variantToken({ iat: t + 600, exp: t + 900 }, { now: t })}` },
        '',
      ],
      [
        'signed with K2',
        { authorization: `Bearer ${signToken(referenceClaims(t), { secret: K2 })}` },
        '',
      ],
      [
        'alg none',
        {
          authorization: `Bearer ${base64urlJson({ alg: 'none', typ: 'JWT' })}.${base64urlJson(referenceClaims(t))}.`,
        },
        '',
      ],
      ['iss other', { authorization: `Bearer ${variantToken({ iss: 'other' }, { now: t })}` }, ''],
      ['aud other', { authorization: `Bearer ${variantToken({ aud: 'other' }, { now: t })}` }, ''],
      [
        'role admin',
        { authorization: `Bearer ${variantToken({ role: 'admin' }, { now: t })}` },
        '',
      ],
    ];
    expect(variants).toHaveLength(13);

    const keys: string[] = [];
    const answers = [];
    for (const [name, headers, query] of variants) {
      const read = await built.app.inject({
        method: 'GET',
        url: `/v1/accounts/${a1.id}${query}`,
        headers,
      });
      const key = randomUUID();
      keys.push(key);
      const withdrawal = await built.app.inject({
        method: 'POST',
        url: `/v1/accounts/${a1.id}/withdrawals${query}`,
        headers: { ...headers, 'idempotency-key': key },
        payload: { amount: '100', currency: 'EUR' },
      });
      answers.push([`read: ${name}`, read] as const, [`withdrawal: ${name}`, withdrawal] as const);
    }

    expect(answers).toHaveLength(26);
    const [, first] = answers[0] ?? [];
    if (first === undefined) throw new Error('no answer');
    const body = withoutRequestId(problemOf(first));
    const challenge = first.headers['www-authenticate'];
    expect(challenge).toEqual(expect.stringMatching(/^Bearer /));
    for (const [name, answer] of answers) {
      expect(answer.statusCode, name).toBe(401);
      const problem = problemOf(answer);
      expect(problem.type, name).toBe('/problems/unauthenticated');
      expect(withoutRequestId(problem), name).toEqual(body);
      expect(answer.headers['www-authenticate'], name).toBe(challenge);
    }

    expect(await balanceOf(a1.id)).toBe('10000');
    const stored = await runtimePool().query(
      'SELECT key FROM idempotency_keys WHERE key = ANY($1::text[])',
      [keys],
    );
    expect(stored.rows).toEqual([]);

    for (const url of ['/health/live', '/docs', '/docs/json']) {
      for (const headers of [{ authorization: `Bearer ${expired}` }, {}]) {
        const response = await built.app.inject({ method: 'GET', url, headers });
        expect(response.statusCode, `${url} ${JSON.stringify(headers)}`).toBe(200);
      }
    }
  });
});
