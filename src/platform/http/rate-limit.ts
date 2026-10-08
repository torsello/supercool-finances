import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import type { RedisAvailability } from '../redis/redis.js';
import { RateLimited } from './errors.js';

/** The prefix of every per-user counter in Redis, followed by the user id (SEC-R04). */
export const RATE_LIMIT_KEY_PREFIX = 'scf:rate-limit:user:';

/** What the per-user limit counts: requests answered 429, and checks that failed open. */
export interface RateLimitObserver {
  rateLimited(): void;
  storeError(): void;
}

export interface RateLimitSettings {
  redis: Redis;
  /** `RATE_LIMIT_USER_MAX`. */
  max: number;
  /** `RATE_LIMIT_USER_WINDOW_S`. */
  windowSeconds: number;
  /** The user id of an authenticated request (AUT-R07). */
  userOf: (request: FastifyRequest) => string;
}

/** The whole seconds left in the window, at least 1 (SEC-R03). */
function retryAfterSeconds(ttlMs: number): number {
  return Math.max(1, Math.ceil(ttlMs / 1000));
}

/** Every header of `@fastify/rate-limit` off: `Retry-After` comes with the problem (SEC-R03). */
const NO_HEADERS = {
  'x-ratelimit-limit': false,
  'x-ratelimit-remaining': false,
  'x-ratelimit-reset': false,
  'retry-after': false,
} as const;

/**
 * Registers `@fastify/rate-limit` on the app without a hook of its own (`global: false`), with its
 * Redis store: a counter per user created with a TTL of the window and incremented atomically by
 * one script, one round trip, the window starting at the user's first request (section 1.6 of
 * spec 007). Above `max` it throws `RateLimited` with the seconds left in the window. The check
 * itself is the hook of `registerUserRateLimit`.
 */
export function registerRateLimitStore(app: FastifyInstance, settings: RateLimitSettings): void {
  void app.register(rateLimit, {
    global: false,
    redis: settings.redis,
    nameSpace: RATE_LIMIT_KEY_PREFIX,
    max: settings.max,
    timeWindow: settings.windowSeconds * 1000,
    keyGenerator: settings.userOf,
    errorResponseBuilder: (_request, context) => new RateLimited(retryAfterSeconds(context.ttl)),
    addHeaders: NO_HEADERS,
    addHeadersOnExceeding: NO_HEADERS,
  });
}

/**
 * The per-user limit as an `onRequest` hook of `scope`, added between authentication and the role
 * check (section 1.3 of spec 007, SEC-R05), so every authenticated request counts, a 403 or a
 * replay included. A store error or a command timeout lets the request through (SEC-R06): it is
 * counted and marks Redis unavailable, which logs only the transition.
 */
export function registerUserRateLimit(
  scope: FastifyInstance,
  options: { availability: RedisAvailability; observer: RateLimitObserver },
): void {
  const check = scope.rateLimit();
  scope.addHook('onRequest', async function userRateLimit(request, reply) {
    try {
      await check.call(this, request, reply);
    } catch (error) {
      if (error instanceof RateLimited) {
        // Redis answered: a 429 is a successful check too.
        options.availability.answered();
        options.observer.rateLimited();
        throw error;
      }
      options.observer.storeError();
      options.availability.failed(error);
      return;
    }
    options.availability.answered();
  });
}
