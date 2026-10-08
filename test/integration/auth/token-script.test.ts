import { execFile } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { balanceOf, closePools } from '../../support/db.js';
import { bearer, createAccount, deposit } from '../../support/http.js';
import {
  C1,
  decodeToken,
  K,
  O1,
  segments,
  TEST_AUDIENCE,
  TEST_ISSUER,
} from '../../support/tokens.js';

const run = promisify(execFile);

/** Runs `npm run --silent token` as a child process with the test token configuration. */
async function token(
  sub: string,
  role: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await run(
      'npm',
      ['run', '--silent', 'token', '--', '--sub', sub, '--role', role],
      {
        env: {
          ...process.env,
          JWT_SECRET: K,
          JWT_ISSUER: TEST_ISSUER,
          JWT_AUDIENCE: TEST_AUDIENCE,
        },
      },
    );
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failed.stdout ?? '', stderr: failed.stderr ?? '', code: failed.code ?? -1 };
  }
}

const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

describe('the token script against the API', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('AUT-AC12 mints tokens the API accepts: one line, an HS256 JWS with exactly the claims of section 1.2', async () => {
    const t1 = Math.floor(Date.now() / 1000);
    const customer = await token(C1.toUpperCase(), 'customer');
    const t2 = Math.floor(Date.now() / 1000);
    const operator = await token(O1, 'operator');

    const tokens: string[] = [];
    for (const result of [customer, operator]) {
      expect(result.code).toBe(0);
      const lines = result.stdout.split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[1]).toBe('');
      const minted = lines[0] ?? '';
      expect(minted).toMatch(COMPACT_JWS);
      expect(result.stdout).not.toContain(K);
      expect(result.stderr).not.toContain(K);
      tokens.push(minted);
    }
    const [customerToken = '', operatorToken = ''] = tokens;

    const { header, claims } = decodeToken(customerToken);
    expect(header).toStrictEqual({ alg: 'HS256', typ: 'JWT' });
    const iat = (claims as { iat: number }).iat;
    expect(Number.isInteger(iat)).toBe(true);
    expect(iat).toBeGreaterThanOrEqual(t1);
    expect(iat).toBeLessThanOrEqual(t2);
    expect(claims).toStrictEqual({
      sub: C1,
      role: 'customer',
      iat,
      exp: iat + 900,
      iss: TEST_ISSUER,
      aud: TEST_AUDIENCE,
    });
    const [h, p, signature] = segments(customerToken);
    expect(createHmac('sha256', K).update(`${h}.${p}`).digest('base64url')).toBe(signature);

    const a1 = await createAccount(built.app, customerToken);
    expect(await balanceOf(a1.id)).toBe('0');
    const read = await built.app.inject({
      method: 'GET',
      url: `/v1/accounts/${a1.id}`,
      headers: bearer(customerToken),
    });
    expect(read.statusCode).toBe(200);
    expect((await deposit(built.app, operatorToken, a1.id, '100')).statusCode).toBe(201);
  });
});
