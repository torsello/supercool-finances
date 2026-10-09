import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { closePools } from '../../support/db.js';
import { bearer, createAccount, problemOf } from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';

/** The names of every `Access-Control-*` header of a response. */
function accessControlHeaders(response: LightMyRequestResponse): string[] {
  return Object.keys(response.headers).filter((name) => name.startsWith('access-control-'));
}

/** A comma-separated header value as a sorted list, whatever the letter case and spaces. */
function listOf(value: unknown): string[] {
  if (typeof value !== 'string') throw new Error(`not a header value: ${String(value)}`);
  return value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .sort();
}

describe('CORS', () => {
  const apps: BuiltApp[] = [];

  afterAll(async () => {
    await Promise.all(
      apps.map(async ({ app }) => {
        await app.close();
      }),
    );
    await closePools();
  });

  async function started(env: Record<string, string | undefined>): Promise<BuiltApp> {
    const built = buildProductionApp({ env });
    apps.push(built);
    await built.app.ready();
    return built;
  }

  async function preflight(built: BuiltApp, accountId: string, origin: string) {
    return await built.app.inject({
      method: 'OPTIONS',
      url: `/v1/accounts/${accountId}/withdrawals`,
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type, idempotency-key',
      },
    });
  }

  async function read(built: BuiltApp, token: string, accountId: string, origin: string) {
    return await built.app.inject({
      method: 'GET',
      url: `/v1/accounts/${accountId}`,
      headers: { ...bearer(token), origin },
    });
  }

  it('SEC-AC12 with CORS_ORIGINS unset no response carries an Access-Control header, and a preflight answers 404', async () => {
    const built = await started({ CORS_ORIGINS: undefined });
    const c1 = tokenFor(randomUUID(), 'customer');
    const a1 = await createAccount(built.app, c1, 'EUR');

    const reading = await read(built, c1, a1.id, 'https://evil.example');
    expect(reading.statusCode).toBe(200);
    expect(accessControlHeaders(reading)).toEqual([]);

    const answer = await built.app.inject({
      method: 'OPTIONS',
      url: `/v1/accounts/${a1.id}/withdrawals`,
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(answer.statusCode).toBe(404);
    expect(problemOf(answer).type).toBe('/problems/not-found');
    expect(accessControlHeaders(answer)).toEqual([]);
  });

  it('SEC-AC13 only the exact configured origin gets CORS headers: the methods, headers and exposed headers of SEC-R17, and never credentials', async () => {
    const built = await started({ CORS_ORIGINS: 'https://app.example' });
    const c1 = tokenFor(randomUUID(), 'customer');
    const a1 = await createAccount(built.app, c1, 'EUR');

    const allowed = await preflight(built, a1.id, 'https://app.example');
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe('https://app.example');
    expect(listOf(allowed.headers['vary'])).toContain('origin');
    expect(listOf(allowed.headers['access-control-allow-methods'])).toEqual(['get', 'post']);
    expect(listOf(allowed.headers['access-control-allow-headers'])).toEqual([
      'authorization',
      'content-type',
      'idempotency-key',
      'x-request-id',
    ]);
    expect(allowed.headers).not.toHaveProperty('access-control-allow-credentials');

    const reading = await read(built, c1, a1.id, 'https://app.example');
    expect(reading.statusCode).toBe(200);
    expect(reading.headers['access-control-allow-origin']).toBe('https://app.example');
    expect(listOf(reading.headers['access-control-expose-headers'])).toEqual([
      'idempotent-replayed',
      'location',
      'retry-after',
      'x-request-id',
    ]);
    expect(reading.headers).not.toHaveProperty('access-control-allow-credentials');

    for (const origin of ['https://app.example.evil', 'http://app.example']) {
      const refused = await preflight(built, a1.id, origin);
      expect(accessControlHeaders(refused), origin).toEqual([]);
      const other = await read(built, c1, a1.id, origin);
      expect(other.statusCode, origin).toBe(200);
      expect(accessControlHeaders(other), origin).toEqual([]);
    }
  });

  it('SEC-R17 SYS-R24 with CORS on, an OPTIONS from an allowed origin without Access-Control-Request-Method is not a preflight and answers the not-found problem', async () => {
    const built = await started({ CORS_ORIGINS: 'https://app.example' });
    const answer = await built.app.inject({
      method: 'OPTIONS',
      url: `/v1/accounts/${randomUUID()}/withdrawals`,
      headers: { origin: 'https://app.example' },
    });
    expect(answer.statusCode).toBe(404);
    expect(problemOf(answer).type).toBe('/problems/not-found');
    expect(accessControlHeaders(answer)).toEqual([]);
  });

  it('SEC-R14 with CORS on, a preflight under /v1 is not stored either, also through a percent-encoded path', async () => {
    const built = await started({ CORS_ORIGINS: 'https://app.example' });
    for (const path of ['/v1/accounts/x/withdrawals', '/%761/accounts/x/withdrawals']) {
      const answer = await built.app.inject({
        method: 'OPTIONS',
        url: path,
        headers: { origin: 'https://app.example', 'access-control-request-method': 'POST' },
      });
      expect(answer.statusCode, path).toBe(204);
      expect(answer.headers['cache-control'], path).toBe('no-store');
    }
  });
});
