import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { closePools, runtimePool } from '../../support/db.js';
import { bearer, createAccount, deposit, problemOf, withdraw } from '../../support/http.js';
import { LOG_LEVEL } from '../../support/logs.js';
import { K, K2, nowSeconds, segments, tokenFor, variantToken } from '../../support/tokens.js';

describe('authentication logs', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('AUT-AC06 never logs, answers or audits a token or the secret, and logs one warn line with the failed check', async () => {
    const c1 = randomUUID();
    const now = nowSeconds();
    const v = variantToken({ sub: c1, role: 'customer' }, { now });
    const e = variantToken({ sub: c1, role: 'customer', iat: now - 600, exp: now - 60 }, { now });
    const w = variantToken({ sub: c1, role: 'customer' }, { now, secret: K2 });
    const a1 = await createAccount(built.app, v);
    const funded = await deposit(built.app, tokenFor(randomUUID(), 'operator'), a1.id, '1000');
    expect(funded.statusCode).toBe(201);

    built.logs.clear();
    const read = async (token: string, requestId: string) =>
      await built.app.inject({
        method: 'GET',
        url: `/v1/accounts/${a1.id}`,
        headers: { ...bearer(token), 'x-request-id': requestId },
      });
    const ok = await read(v, 'req-ok');
    const expired = await read(e, 'req-exp');
    const badSignature = await read(w, 'req-sig');
    const withdrawal = await withdraw(built.app, v, a1.id, '100');

    expect(ok.statusCode).toBe(200);
    expect(expired.statusCode).toBe(401);
    expect(badSignature.statusCode).toBe(401);
    expect(withdrawal.statusCode).toBe(201);

    const audits = await runtimePool().query<{ row: unknown }>(
      'SELECT row_to_json(a) AS row FROM audit_records a WHERE $1::uuid = ANY (account_ids)',
      [a1.id],
    );
    expect(audits.rows.length).toBeGreaterThan(0);
    const texts = [
      built.logs.text(),
      expired.body,
      badSignature.body,
      JSON.stringify(audits.rows.map(({ row }) => row)),
    ];
    const secrets = [v, e, w, segments(v)[2], segments(e)[2], segments(w)[2], K];
    for (const text of texts) {
      for (const secret of secrets) expect(text.includes(secret)).toBe(false);
    }

    const warnings = (reqId: string) =>
      built.logs.linesOf(reqId).filter((line) => line.level === LOG_LEVEL.warn);
    expect(warnings('req-exp')).toEqual([expect.objectContaining({ reason: 'expired' })]);
    expect(warnings('req-sig')).toEqual([expect.objectContaining({ reason: 'signature' })]);

    for (const response of [expired, badSignature]) {
      problemOf(response);
      expect(response.body).not.toContain('expired');
      expect(response.body).not.toContain('signature');
    }
  });
});
