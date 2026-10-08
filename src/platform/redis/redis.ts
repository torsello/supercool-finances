import { setTimeout as delay } from 'node:timers/promises';
import { Redis } from 'ioredis';

/** The longest wait between two reconnection attempts, in milliseconds. */
const MAX_RECONNECT_DELAY_MS = 2000;

/**
 * The Redis client of the per-user rate-limit counters, the only thing Redis holds (SEC-R07):
 * every command fails after `commandTimeoutMs` (`REDIS_COMMAND_TIMEOUT_MS`) without an answer,
 * and a command sent while the connection is down fails at once instead of waiting in a queue, so
 * a Redis outage never delays a request beyond one command timeout (SEC-R06). It connects only
 * when `connect` is called and then reconnects on its own, every 50 ms more up to 2 s.
 */
export function createRedis(options: { url: string; commandTimeoutMs: number }): Redis {
  return new Redis(options.url, {
    commandTimeout: options.commandTimeoutMs,
    enableOfflineQueue: false,
    lazyConnect: true,
    retryStrategy: (attempts) => Math.min(attempts * 50, MAX_RECONNECT_DELAY_MS),
  });
}

/**
 * Starts connecting, and waits for the connection to be ready for at most `waitMs`, so the first
 * requests of a healthy Redis are counted; a Redis that is down never stops the service from
 * starting, and the client keeps reconnecting (SEC-R06).
 */
export async function connectRedis(redis: Redis, waitMs: number): Promise<void> {
  const connected = redis.connect().then(
    () => undefined,
    () => undefined,
  );
  await Promise.race([connected, delay(waitMs, undefined, { ref: false })]);
}

/** Closes the connection at once, without waiting for commands in flight, and stops reconnecting. */
export function disconnectRedis(redis: Redis): void {
  redis.disconnect(false);
}

/** The part of the logger the transitions are written with; pino's fits it. */
export interface AvailabilityLogger {
  warn(fields: Record<string, unknown>, message: string): void;
  info(message: string): void;
}

/** The code of a connection or command error, never its message. */
function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

/**
 * Whether Redis answers, logged once per transition instead of once per request (SEC-R06): one
 * `warn` line when it becomes unavailable (a connection error, or a command that failed or timed
 * out) and one `info` line when it answers again (the connection is ready, or a command
 * answered). It starts as available, so a healthy start logs nothing.
 */
export class RedisAvailability {
  readonly #logger: AvailabilityLogger;
  #available = true;

  constructor(logger: AvailabilityLogger) {
    this.#logger = logger;
  }

  /** Follows the client's connection: `error` on every failed (re)connection, `ready` once up. */
  watch(redis: Redis): void {
    redis.on('error', (error: unknown) => {
      this.failed(error);
    });
    redis.on('ready', () => {
      this.answered();
    });
  }

  failed(error: unknown): void {
    if (!this.#available) return;
    this.#available = false;
    this.#logger.warn(
      { code: codeOf(error) ?? null },
      'Redis unavailable: the per-user rate limit lets requests through',
    );
  }

  answered(): void {
    if (this.#available) return;
    this.#available = true;
    this.#logger.info('Redis available: the per-user rate limit applies again');
  }
}
