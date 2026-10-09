import { randomUUID } from 'node:crypto';
import { request as httpRequest, Agent } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { createAccount } from '../../support/http.js';
import {
  TEST_SEAMS,
  THROWING_ROUTE_PATH,
  buildTestApp,
  type BuiltTestApp,
} from '../../support/test-app.js';
import { tokenFor } from '../../support/tokens.js';

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  /** Whether the client connection was still open once the answer was read. */
  open: boolean;
}

describe('test seams (SYS-R37)', () => {
  let production: BuiltApp;
  let testApp: BuiltTestApp;
  let port: number;
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });

  beforeAll(async () => {
    // Production configuration: NODE_ENV production, so its stricter rules apply (DEP-R07).
    production = buildProductionApp({ env: { NODE_ENV: 'production' } });
    testApp = buildTestApp();
    await production.app.listen({ host: '127.0.0.1', port: 0 });
    await testApp.app.ready();
    const address = production.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no TCP address');
    port = address.port;
  });

  afterAll(async () => {
    agent.destroy();
    await production.app.close();
    await testApp.app.close();
  });

  /** Sends one request over TCP to the production app, on a kept-alive connection. */
  async function send(
    method: string,
    path: string,
    token: string,
    body?: unknown,
  ): Promise<Answer> {
    return await new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          agent,
          headers: {
            authorization: `Bearer ${token}`,
            ...(payload === undefined
              ? {}
              : { 'content-type': 'application/json', 'idempotency-key': randomUUID() }),
          },
        },
        (res) => {
          const socket = res.socket;
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (text += chunk));
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: text,
              open: !socket.destroyed,
            });
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  }

  it('SYS-AC24 attaches the five test seams to the test app only, and the production app serves without them', async () => {
    // The test app lists the throwing route and exactly the five seams of SYS-R37.
    const testRoutes = testApp.app.printRoutes({ commonPrefix: false });
    expect(testRoutes).toContain('/v1/test/throw');
    expect([...testApp.app.testSeams].sort()).toEqual([...TEST_SEAMS].sort());

    // The production app lists none, and no component has a hook attached.
    const productionRoutes = production.app.printRoutes({ commonPrefix: false });
    expect(productionRoutes).not.toContain('/test/throw');
    expect(production.app.testSeams).toEqual([]);
    expect(production.app.attachedTestHooks()).toEqual({
      unitOfWork: [],
      reversals: [],
      responseHandling: [],
      connectionHandling: [],
    });
    expect(testApp.app.attachedTestHooks()).toEqual({
      unitOfWork: ['unit-of-work-faults'],
      reversals: ['skip-existing-reversal-check'],
      responseHandling: ['extra-response-member'],
      connectionHandling: ['destroy-connection-after-commit'],
    });

    // On the production app: the throwing route's path is unknown, a deposit and its reversals
    // answer as usual, over an open connection.
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(production.app, tokenFor(randomUUID(), 'customer'));

    const thrown = await send('GET', THROWING_ROUTE_PATH, o1);
    expect(thrown.status).toBe(404);
    expect(JSON.parse(thrown.body)).toMatchObject({ type: '/problems/not-found' });

    const deposited = await send('POST', `/v1/accounts/${a1.id}/deposits`, o1, {
      amount: '100',
      currency: 'EUR',
    });
    expect(deposited.status).toBe(201);
    expect(deposited.open).toBe(true);
    const d = JSON.parse(deposited.body) as Record<string, unknown>;
    expect(Object.keys(d).sort()).toEqual(['amount', 'createdAt', 'currency', 'id', 'kind']);
    expect(d).toMatchObject({ kind: 'deposit', amount: '100', currency: 'EUR' });
    expect(deposited.headers['location']).toBe(`/v1/transactions/${String(d['id'])}`);

    const reversal = { reason: 'Operator correction' };
    const first = await send('POST', `/v1/transactions/${String(d['id'])}/reversals`, o1, reversal);
    expect(first.status).toBe(201);
    const second = await send(
      'POST',
      `/v1/transactions/${String(d['id'])}/reversals`,
      o1,
      reversal,
    );
    expect(second.status).toBe(409);
    expect(JSON.parse(second.body)).toMatchObject({ type: '/problems/already-reversed' });
  });
});
