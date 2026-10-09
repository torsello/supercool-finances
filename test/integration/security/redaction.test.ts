import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, TEST_CURSOR_SECRET, type BuiltApp } from '../../support/app.js';
import { closePools, ownerPool } from '../../support/db.js';
import { requireEnv } from '../../support/env.js';
import { bearer, createAccount, deposit } from '../../support/http.js';
import type { LogLine } from '../../support/logs.js';
import { K, nowSeconds, tokenFor, variantToken } from '../../support/tokens.js';

const DB_PASSWORD = 'db-pw-7781';
const REDIS_PASSWORD = 'redis-pw-5512';

/** `url` with its user and password replaced. */
function withCredentials(url: string, user: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = user;
  parsed.password = password;
  return parsed.toString();
}

describe('log redaction', () => {
  /**
   * A login role of this AC with the password the AC names, a member of the runtime role, so the
   * app works with that password; dropped afterwards (the owner role may create roles, section
   * 1.3 of spec 002).
   */
  const role = `scf_redaction_${randomBytes(4).toString('hex')}`;
  let databaseUrl: string;
  let redisUrl: string;

  beforeAll(async () => {
    await ownerPool().query(
      `CREATE ROLE ${role} WITH LOGIN PASSWORD '${DB_PASSWORD}' IN ROLE scf_app`,
    );
    databaseUrl = withCredentials(requireEnv('TEST_DATABASE_URL'), role, DB_PASSWORD);
    redisUrl = withCredentials(requireEnv('REDIS_URL'), '', REDIS_PASSWORD);
  });

  afterAll(async () => {
    await ownerPool().query(`DROP ROLE IF EXISTS ${role}`);
    await closePools();
  });

  function appWith(env: Record<string, string>): BuiltApp {
    return buildProductionApp({
      env: {
        LOG_LEVEL: 'trace',
        JWT_SECRET: K,
        CURSOR_SECRET: TEST_CURSOR_SECRET,
        REDIS_URL: redisUrl,
        ...env,
      },
    });
  }

  /** The request log line of `reqId`: the one that records the request. */
  function requestLine(built: BuiltApp, reqId: string): LogLine & { req: Record<string, unknown> } {
    const line = built.logs
      .linesOf(reqId)
      .find((candidate) => candidate.msg === 'incoming request');
    if (line === undefined) throw new Error(`no request log line for ${reqId}`);
    return line as LogLine & { req: Record<string, unknown> };
  }

  it('SEC-AC17 no log line holds a token, a secret, a password, an Idempotency-Key, a cookie or a query string', async () => {
    const c1Id = randomUUID();
    const v = tokenFor(c1Id, 'customer');
    const now = nowSeconds();
    const expired = variantToken({ sub: c1Id, role: 'customer', iat: now - 1000, exp: now - 100 });
    const v2 = variantToken({ sub: c1Id, role: 'customer', iat: now - 30 }, { now });
    expect(v2).not.toBe(v);
    const o1 = tokenFor(randomUUID(), 'operator');

    const built = appWith({ DATABASE_URL: databaseUrl });
    let text: string;
    let a1Id: string;
    try {
      await built.app.ready();
      const a1 = await createAccount(built.app, v, 'EUR');
      a1Id = a1.id;
      expect((await deposit(built.app, o1, a1.id, '1000')).statusCode).toBe(201);

      const withdrawal = await built.app.inject({
        method: 'POST',
        url: `/v1/accounts/${a1.id}/withdrawals`,
        headers: {
          ...bearer(v),
          'idempotency-key': 'k-secret-777',
          cookie: 'session=abc123',
          'x-request-id': 'redact-withdrawal',
        },
        payload: { amount: '100', currency: 'EUR' },
      });
      expect(withdrawal.statusCode).toBe(201);
      const expiredRead = await built.app.inject({
        method: 'GET',
        url: `/v1/accounts/${a1.id}`,
        headers: bearer(expired),
      });
      expect(expiredRead.statusCode).toBe(401);
      const queryToken = await built.app.inject({
        method: 'GET',
        url: `/v1/accounts/${a1.id}?access_token=${v2}`,
        headers: { 'x-request-id': 'redact-query-token' },
      });
      expect(queryToken.statusCode).toBe(401);
      const unknownParameter = await built.app.inject({
        method: 'GET',
        url: `/v1/accounts/${a1.id}?note=q-secret-991`,
        headers: { ...bearer(v), 'x-request-id': 'redact-query-note' },
      });
      expect(unknownParameter.statusCode).toBe(422);

      for (const reqId of ['redact-query-token', 'redact-query-note']) {
        expect(requestLine(built, reqId).req['url'], reqId).toBe(`/v1/accounts/${a1.id}`);
      }
      const headers = requestLine(built, 'redact-withdrawal').req['headers'] as Record<
        string,
        unknown
      >;
      expect(headers).toMatchObject({
        authorization: '[Redacted]',
        cookie: '[Redacted]',
        'idempotency-key': '[Redacted]',
      });
      text = built.logs.text();
    } finally {
      await built.app.close();
    }

    // The same password against a port where nothing listens: the connection errors are logged.
    const unreachable = new URL(databaseUrl);
    unreachable.host = '127.0.0.1:1';
    const restarted = appWith({ DATABASE_URL: unreachable.toString() });
    try {
      await restarted.app.ready();
      const failed = await restarted.app.inject({
        method: 'GET',
        url: `/v1/accounts/${a1Id}`,
        headers: bearer(v),
      });
      expect(failed.statusCode).toBe(500);
      expect(restarted.logs.lines().some((line) => line.level === 50)).toBe(true);
      text += restarted.logs.text();
    } finally {
      await restarted.app.close();
    }

    for (const secret of [
      v,
      expired,
      v2,
      'access_token',
      'q-secret-991',
      'k-secret-777',
      'abc123',
      K,
      TEST_CURSOR_SECRET,
      DB_PASSWORD,
      REDIS_PASSWORD,
    ]) {
      expect(text.includes(secret), `the logs hold ${secret}`).toBe(false);
    }
  });
});
