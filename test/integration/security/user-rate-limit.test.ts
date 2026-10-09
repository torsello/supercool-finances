import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RATE_LIMIT_KEY_PREFIX } from '../../../src/platform/http/rate-limit.js';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { balanceOf, closePools, createCustomerAccount } from '../../support/db.js';
import { requireEnv } from '../../support/env.js';
import { bearer, deposit, problemOf, withdraw } from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';

describe('the per-user rate limit', () => {
  const apps: BuiltApp[] = [];
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis(requireEnv('REDIS_URL'), { maxRetriesPerRequest: 1 });
  });

  afterAll(async () => {
    await Promise.all(
      apps.map(async ({ app }) => {
        await app.close();
      }),
    );
    await redis.quit();
    await closePools();
  });

  async function started(env: Record<string, string>): Promise<BuiltApp> {
    const built = buildProductionApp({ env });
    apps.push(built);
    await built.app.ready();
    return built;
  }

  async function read(built: BuiltApp, token: string | undefined, accountId: string) {
    return await built.app.inject({
      method: 'GET',
      url: `/v1/accounts/${accountId}`,
      headers: token === undefined ? {} : bearer(token),
    });
  }

  it('SEC-AC02 a user is answered 429 above the limit within the window, whatever the earlier answers were, others are not, and the limit resets with the window', async () => {
    const built = await started({ RATE_LIMIT_USER_MAX: '5', RATE_LIMIT_USER_WINDOW_S: '10' });
    const c1Id = randomUUID();
    const c2Id = randomUUID();
    const c1 = tokenFor(c1Id, 'customer');
    const c2 = tokenFor(c2Id, 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    // Written directly, so that C1's only requests are those of the AC.
    const a1 = await createCustomerAccount({ currency: 'EUR', ownerId: c1Id });
    const b1 = await createCustomerAccount({ currency: 'EUR', ownerId: c2Id });
    expect((await deposit(built.app, o1, a1.id, '1000')).statusCode).toBe(201);
    const k1 = randomUUID();

    const first = [
      await read(built, c1, a1.id),
      await read(built, c1, a1.id),
      await read(built, c1, a1.id),
      await deposit(built.app, c1, a1.id, '100'),
      await withdraw(built.app, c1, a1.id, '100', { key: k1 }),
    ];
    expect(first.map((response) => response.statusCode)).toEqual([200, 200, 200, 403, 201]);

    const sixth = await withdraw(built.app, c1, a1.id, '100', { key: k1 });
    expect(sixth.statusCode).toBe(429);
    expect(problemOf(sixth).type).toBe('/problems/rate-limited');
    const retryAfter = Number(sixth.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(10);
    expect(sixth.headers).not.toHaveProperty('idempotent-replayed');
    expect(await balanceOf(a1.id)).toBe('900');

    expect((await read(built, c2, b1.id)).statusCode).toBe(200);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const anonymous = await read(built, undefined, a1.id);
      expect(anonymous.statusCode).toBe(401);
    }

    // The window ends when Redis expires C1's counter.
    const counter = `${RATE_LIMIT_KEY_PREFIX}${c1Id}`;
    const deadline = Date.now() + 15_000;
    while ((await redis.exists(counter)) === 1) {
      if (Date.now() > deadline) throw new Error('the counter did not expire');
      await delay(100);
    }
    expect((await read(built, c1, a1.id)).statusCode).toBe(200);
  }, 30_000);

  it('SEC-AC03 every replica counts against one counter per user in Redis', async () => {
    const env = { RATE_LIMIT_USER_MAX: '4', RATE_LIMIT_USER_WINDOW_S: '60' };
    const p1 = await started(env);
    const p2 = await started(env);
    const c1Id = randomUUID();
    const c1 = tokenFor(c1Id, 'customer');
    const a1 = await createCustomerAccount({ currency: 'EUR', ownerId: c1Id });

    const answers = [
      await read(p1, c1, a1.id),
      await read(p1, c1, a1.id),
      await read(p2, c1, a1.id),
      await read(p2, c1, a1.id),
      await read(p1, c1, a1.id),
      await read(p2, c1, a1.id),
    ];

    expect(answers.map((response) => response.statusCode)).toEqual([200, 200, 200, 200, 429, 429]);
    for (const refused of answers.slice(4)) {
      expect(problemOf(refused).type).toBe('/problems/rate-limited');
    }
    const counters: string[] = [];
    for await (const keys of redis.scanStream({ match: `*${c1Id}*` })) {
      counters.push(...(keys as string[]));
    }
    expect(counters).toEqual([`${RATE_LIMIT_KEY_PREFIX}${c1Id}`]);
    await redis.del(counters);
  });
});
