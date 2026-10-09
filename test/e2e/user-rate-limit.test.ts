import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RATE_LIMIT_KEY_PREFIX } from '../../src/platform/http/rate-limit.js';
import { createAccount, getAccount } from './support/api.js';
import { headerOf, problemOf, type E2eResponse } from './support/http.js';
import { ensureStack } from './support/stack.js';
import { freshUser } from './support/tokens.js';
import { publishedPort } from './support/urls.js';
import { waitFor } from './support/wait.js';

describe('the per-user limit with its defaults', () => {
  let redis: Redis;

  beforeAll(async () => {
    await ensureStack();
    redis = new Redis({
      host: '127.0.0.1',
      port: Number(publishedPort('redis', '6379')),
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    await redis.connect();
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('SEC-AC04 a dedicated user exceeds the default per-user limit, and another user is not affected', async () => {
    // C9 is used by no other test. Creating A9 is one of its requests, so its reads start in a
    // window of their own: once the counter of that request has expired in Redis.
    const c9 = await freshUser('customer');
    const a9 = (await createAccount(c9.token)).id;
    const c1 = await freshUser('customer');
    const a1 = (await createAccount(c1.token)).id;
    await waitFor(
      'the window of C9’s account creation to end',
      async () =>
        (await redis.exists(`${RATE_LIMIT_KEY_PREFIX}${c9.id}`)) === 0 ? true : undefined,
      { timeoutMs: 60_000 },
    );

    // 300 reads as fast as possible, in parallel lanes, while C1 reads A1; then the 301st.
    const first = performance.now();
    const lanes = 10;
    const [reads, c1Read] = await Promise.all([
      Promise.all(
        Array.from({ length: lanes }, async () => {
          const answers: E2eResponse[] = [];
          for (let index = 0; index < 300 / lanes; index += 1) {
            answers.push(await getAccount(c9.token, a9));
          }
          return answers;
        }),
      ),
      getAccount(c1.token, a1),
    ]);
    const last = await getAccount(c9.token, a9);
    expect(performance.now() - first).toBeLessThan(10_000);

    const statuses = reads.flat().map((response) => response.status);
    expect(statuses).toHaveLength(300);
    expect(statuses.filter((status) => status !== 200)).toEqual([]);
    expect(last.status).toBe(429);
    expect(problemOf(last).type).toBe('/problems/rate-limited');
    const retryAfter = Number(headerOf(last, 'retry-after'));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(10);
    expect(c1Read.status).toBe(200);
  });
});
