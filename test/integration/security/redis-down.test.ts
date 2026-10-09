import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listen } from '../../../src/app.js';
import { buildProductionApp, testConfig, type BuiltApp } from '../../support/app.js';
import { balanceOf, closePools, createCustomerAccount } from '../../support/db.js';
import { requireEnv } from '../../support/env.js';
import { bearer, deposit, problemOf, withdraw } from '../../support/http.js';
import { LOG_LEVEL, type LogLine } from '../../support/logs.js';
import { scrape, valueOf } from '../../support/metrics.js';
import { freePort } from '../../support/ports.js';
import { TcpProxy } from '../../support/tcp-proxy.js';
import { tokenFor } from '../../support/tokens.js';

describe('without Redis', () => {
  let proxy: TcpProxy;
  let built: BuiltApp;
  let metricsPort: number;

  beforeAll(async () => {
    // Nothing listens on the proxy's port until the test starts Redis there (plan 007 section 6).
    proxy = await TcpProxy.to(requireEnv('REDIS_URL'));
    metricsPort = await freePort();
    const env = {
      REDIS_URL: `redis://127.0.0.1:${String(proxy.port)}`,
      RATE_LIMIT_USER_MAX: '1',
      PORT: String(await freePort()),
      METRICS_PORT: String(metricsPort),
    };
    built = buildProductionApp({ env });
    await listen(built.app, testConfig(env), '127.0.0.1');
  });

  afterAll(async () => {
    await built.app.close();
    await proxy.stop();
    await closePools();
  });

  const unavailable = (line: LogLine) =>
    line.level === LOG_LEVEL.warn && /Redis unavailable/.test(line.msg ?? '');
  const available = (line: LogLine) =>
    line.level === LOG_LEVEL.info && /Redis available/.test(line.msg ?? '');

  it('SEC-AC06 with Redis down the app starts, serves every request as under the limit and keeps money correct; the limit applies again once Redis is back', async () => {
    const c1Id = randomUUID();
    const c1 = tokenFor(c1Id, 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await createCustomerAccount({ currency: 'EUR', ownerId: c1Id });
    expect((await deposit(built.app, o1, a1.id, '1000')).statusCode).toBe(201);
    const read = async () =>
      await built.app.inject({ method: 'GET', url: `/v1/accounts/${a1.id}`, headers: bearer(c1) });

    for (let attempt = 0; attempt < 3; attempt += 1) expect((await read()).statusCode).toBe(200);

    const keys = Array.from({ length: 10 }, () => randomUUID());
    const withdrawals = await Promise.all(
      keys.map(async (key) => await withdraw(built.app, c1, a1.id, '300', { key })),
    );
    const statuses = withdrawals.map((response) => response.statusCode);
    expect(statuses.filter((status) => status === 201)).toHaveLength(3);
    expect(statuses.filter((status) => status === 422)).toHaveLength(7);
    for (const refused of withdrawals.filter((response) => response.statusCode === 422)) {
      expect(problemOf(refused).type).toBe('/problems/insufficient-funds');
    }
    const appliedKey = keys[statuses.indexOf(201)];
    const repeated = await withdraw(built.app, c1, a1.id, '300', { key: appliedKey });
    expect(repeated.statusCode).toBe(201);
    expect(repeated.headers['idempotent-replayed']).toBe('true');
    expect(await balanceOf(a1.id)).toBe('100');

    const ready = await built.app.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(200);

    expect(built.logs.lines().filter(unavailable)).toHaveLength(1);
    expect(built.logs.lines().filter(available)).toHaveLength(0);
    await proxy.start();
    const deadline = Date.now() + 10_000;
    while (!built.logs.lines().some(available)) {
      if (Date.now() > deadline) throw new Error('the app never logged that Redis is available');
      await delay(20);
    }

    const first = await read();
    const second = await read();
    expect([first.statusCode, second.statusCode]).toEqual([200, 429]);
    expect(problemOf(second).type).toBe('/problems/rate-limited');
    const lines = built.logs.lines();
    expect(lines.filter(unavailable)).toHaveLength(1);
    expect(lines.filter(available)).toHaveLength(1);
    expect(lines.findIndex(unavailable)).toBeLessThan(lines.findIndex(available));
    expect(
      valueOf(await scrape(metricsPort), 'scf_rate_limit_store_errors_total'),
    ).toBeGreaterThanOrEqual(14);
  });
});
