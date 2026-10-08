import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectRedis, createRedis, disconnectRedis } from '../../../src/platform/redis/redis.js';
import { RATE_LIMIT_KEY_PREFIX } from '../../../src/platform/http/rate-limit.js';
import { buildProductionApp } from '../../support/app.js';
import { closePools } from '../../support/db.js';
import { requireEnv } from '../../support/env.js';
import { bearer, createAccount, deposit, freshKey, withdraw } from '../../support/http.js';
import { TcpProxy } from '../../support/tcp-proxy.js';
import { tokenFor } from '../../support/tokens.js';

const COMMAND_TIMEOUT_MS = 100;

/** How long a promise took to settle, in milliseconds, and whether it was rejected. */
async function timed(command: Promise<unknown>): Promise<{ ms: number; rejected: boolean }> {
  const started = performance.now();
  const rejected = await command.then(
    () => false,
    () => true,
  );
  return { ms: performance.now() - started, rejected };
}

describe('the Redis client', () => {
  let admin: Redis;

  beforeAll(() => {
    admin = new Redis(requireEnv('REDIS_URL'), { maxRetriesPerRequest: 1 });
  });

  afterAll(async () => {
    await admin.quit();
    await closePools();
  });

  it('SEC-R06 with Redis unreachable a command fails at once and is never queued for a later connection', async () => {
    const proxy = await TcpProxy.to(requireEnv('REDIS_URL'));
    const redis = createRedis({
      url: `redis://127.0.0.1:${String(proxy.port)}`,
      commandTimeoutMs: COMMAND_TIMEOUT_MS,
    });
    redis.on('error', () => undefined);
    const key = `scf:test:never-queued:${randomUUID()}`;
    try {
      await connectRedis(redis, COMMAND_TIMEOUT_MS);
      const down = await timed(redis.set(key, 'queued'));
      expect(down.rejected).toBe(true);
      expect(down.ms).toBeLessThan(COMMAND_TIMEOUT_MS);

      await proxy.start();
      if (redis.status !== 'ready') await once(redis, 'ready');
      expect(await redis.get(key)).toBeNull();
      expect(await admin.exists(key)).toBe(0);
    } finally {
      disconnectRedis(redis);
      await proxy.stop();
    }
  });

  it('SEC-R06 a command Redis does not answer fails after REDIS_COMMAND_TIMEOUT_MS', async () => {
    const redis = createRedis({
      url: requireEnv('REDIS_URL'),
      commandTimeoutMs: COMMAND_TIMEOUT_MS,
    });
    redis.on('error', () => undefined);
    try {
      await connectRedis(redis, 1000);
      expect(redis.status).toBe('ready');
      // Redis holds every client's commands for 1 s; this one must not wait that long.
      await admin.call('CLIENT', 'PAUSE', '1000', 'ALL');
      const paused = await timed(redis.incr(`scf:test:paused:${randomUUID()}`));
      expect(paused.rejected).toBe(true);
      expect(paused.ms).toBeGreaterThanOrEqual(COMMAND_TIMEOUT_MS - 5);
      expect(paused.ms).toBeLessThan(900);
    } finally {
      await admin.call('CLIENT', 'UNPAUSE');
      disconnectRedis(redis);
    }
  });

  it('SEC-R07 the service writes nothing to Redis but the per-user counters', async () => {
    // A Redis database of its own, so only this app's keys are in it.
    const url = new URL(requireEnv('REDIS_URL'));
    url.pathname = '/14';
    const own = new Redis(url.toString(), { maxRetriesPerRequest: 1 });
    await own.flushdb();
    const built = buildProductionApp({ env: { REDIS_URL: url.toString() } });
    try {
      await built.app.ready();
      const c1Id = randomUUID();
      const c1 = tokenFor(c1Id, 'customer');
      const o1Id = randomUUID();
      const o1 = tokenFor(o1Id, 'operator');
      const a1 = await createAccount(built.app, c1, 'EUR');
      expect((await deposit(built.app, o1, a1.id, '1000')).statusCode).toBe(201);
      const key = freshKey();
      expect((await withdraw(built.app, c1, a1.id, '100', { key })).statusCode).toBe(201);
      expect((await withdraw(built.app, c1, a1.id, '100', { key })).statusCode).toBe(201);
      const read = await built.app.inject({
        method: 'GET',
        url: `/v1/accounts/${a1.id}/entries`,
        headers: bearer(c1),
      });
      expect(read.statusCode).toBe(200);

      expect((await own.keys('*')).sort()).toEqual(
        [`${RATE_LIMIT_KEY_PREFIX}${c1Id}`, `${RATE_LIMIT_KEY_PREFIX}${o1Id}`].sort(),
      );
    } finally {
      await built.app.close();
      await own.flushdb();
      await own.quit();
    }
  });
});
