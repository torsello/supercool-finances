import { randomUUID } from 'node:crypto';
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
import { tokenFor } from '../../support/tokens.js';

/**
 * The full path of every route in Fastify's route list, rebuilt from the tree `printRoutes`
 * prints: each line holds a segment at a depth of four characters per level.
 */
function routeList(tree: string): string[] {
  const stack: string[] = [];
  const paths: string[] = [];
  for (const line of tree.split('\n')) {
    const marker = line.indexOf('── ');
    if (marker < 0) continue;
    const depth = (marker - 1) / 4;
    const segment = line.slice(marker + 3).replace(/ \(.*\)$/, '');
    stack.length = depth;
    stack.push(segment);
    paths.push(stack.join(''));
  }
  return paths;
}

describe('versioned paths', () => {
  let built: BuiltApp;
  let metricsPort: number;

  beforeAll(async () => {
    metricsPort = await freePort();
    const env = { PORT: String(await freePort()), METRICS_PORT: String(metricsPort) };
    built = buildProductionApp({ env });
    await listen(built.app, testConfig(env), '127.0.0.1');
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('SYS-AC29 every API endpoint is served under /v1 only; health, docs and metrics are outside it', async () => {
    const c1Id = randomUUID();
    const c1 = tokenFor(c1Id, 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await createCustomerAccount({ currency: 'EUR', ownerId: c1Id });
    await writeDirectDeposit(a1, '1000');
    const deposit = async (path: string) =>
      await built.app.inject({
        method: 'POST',
        url: path,
        headers: { ...bearer(o1), 'idempotency-key': freshKey() },
        payload: { amount: '100', currency: 'EUR' },
      });

    expect(
      (await built.app.inject({ method: 'GET', url: `/v1/accounts/${a1.id}`, headers: bearer(c1) }))
        .statusCode,
    ).toBe(200);
    for (const response of [
      await built.app.inject({ method: 'GET', url: `/accounts/${a1.id}`, headers: bearer(c1) }),
      await deposit(`/accounts/${a1.id}/deposits`),
    ]) {
      expect(response.statusCode).toBe(404);
      expect(problemOf(response).type).toBe('/problems/not-found');
    }
    const deposited = await deposit(`/v1/accounts/${a1.id}/deposits`);
    expect(deposited.statusCode).toBe(201);
    expect(deposited.headers['location']).toMatch(/^\/v1\/transactions\/[0-9a-f-]{36}$/);
    expect(await balanceOf(a1.id)).toBe('1100');
    const created = await built.app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: bearer(c1),
      payload: { currency: 'EUR' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers['location']).toMatch(/^\/v1\/accounts\/[0-9a-f-]{36}$/);

    for (const path of ['/health/live', '/docs', '/docs/json']) {
      expect((await built.app.inject({ method: 'GET', url: path })).statusCode, path).toBe(200);
      expect((await built.app.inject({ method: 'GET', url: `/v1${path}` })).statusCode, path).toBe(
        404,
      );
    }
    const metrics = `http://127.0.0.1:${String(metricsPort)}`;
    expect((await fetch(`${metrics}/metrics`)).status).toBe(200);
    expect((await fetch(`${metrics}/v1/metrics`)).status).toBe(404);

    const routes = routeList(built.app.printRoutes({ commonPrefix: false }));
    expect(routes).toEqual(
      expect.arrayContaining([
        '/health/live',
        '/health/ready',
        '/docs',
        '/v1/accounts',
        '/v1/accounts/:id/withdrawals',
        '/v1/transactions/:id/reversals',
      ]),
    );
    const outside = routes.filter((url) => !url.startsWith('/v1/'));
    expect(outside.length).toBeGreaterThan(0);
    for (const url of outside) {
      expect(url, url).toMatch(/^\/(health\/(live|ready)|docs)(\/|$)/);
    }
  });
});
