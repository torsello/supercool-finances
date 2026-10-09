import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { RateLimited } from '../../../src/platform/http/errors.js';
import { registerUserRateLimit } from '../../../src/platform/http/rate-limit.js';
import { RedisAvailability } from '../../../src/platform/redis/redis.js';

describe('the per-user rate limit hook', () => {
  it('SEC-R06 a check Redis answered with a 429 marks Redis available again before the 429 is sent', async () => {
    const logged: string[] = [];
    const availability = new RedisAvailability({
      warn: (_fields, message) => logged.push(`warn ${message}`),
      info: (message) => logged.push(`info ${message}`),
    });
    // A command timed out earlier while the connection stayed ready, so no `ready` event follows.
    availability.failed(new Error('Command timed out'));
    const app = Fastify();
    // The check of `@fastify/rate-limit`, as Redis answers it for a user above the limit.
    app.decorate('rateLimit', () => () => Promise.reject(new RateLimited(7)));
    const counted: string[] = [];
    registerUserRateLimit(app, {
      availability,
      observer: {
        rateLimited: () => counted.push('rate-limited'),
        storeError: () => counted.push('store-error'),
      },
    });
    app.get('/limited', () => 'never');
    try {
      const response = await app.inject({ method: 'GET', url: '/limited' });
      expect(response.statusCode).toBe(500);
      expect(counted).toEqual(['rate-limited']);
      expect(logged).toEqual([
        'warn Redis unavailable: the per-user rate limit lets requests through',
        'info Redis available: the per-user rate limit applies again',
      ]);
    } finally {
      await app.close();
    }
  });
});
