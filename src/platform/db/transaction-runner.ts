import { setTimeout as delay } from 'node:timers/promises';
import { RetriesExhausted } from './errors.js';
import { classifyDatabaseError, isRetryable } from './sqlstate.js';

/** Attempts in total for a money movement, the first included (SYS-R18). */
export const MAX_ATTEMPTS = 3;

/** Upper bound, in ms, of the random wait before retry `retry` (1-based): min(200, 10 × 2^(n−1)). */
export function backoffBound(retry: number): number {
  return Math.min(200, 10 * 2 ** (retry - 1));
}

/** The part of a pooled `pg` client the runner uses; `pg.PoolClient` fits it. */
export interface RunnerClient {
  query(text: string): Promise<{ command: string }>;
  /** `'I'` idle, `'T'` in a transaction, `'E'` in a failed transaction, `null` unknown. */
  getTransactionStatus(): string | null;
  /** With an error, the pool destroys the client instead of handing it to another request. */
  release(error?: Error): void;
  /** A lost connection emits `'error'`, which ends the process when nothing listens. */
  on(event: 'error', listener: (error: Error) => void): unknown;
  off(event: 'error', listener: (error: Error) => void): unknown;
}

export interface RunnerPool<Client extends RunnerClient> {
  connect(): Promise<Client>;
}

/** `movement` retries 40P01 and 40001 (SYS-R18); `none` never retries (plan 000 section 6.1). */
export type RetryPolicy = 'movement' | 'none';

export interface TransactionRunnerOptions<Client extends RunnerClient> {
  pool: RunnerPool<Client>;
  /** A number in [0, 1), `Math.random` by default. */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const BEGIN = 'BEGIN ISOLATION LEVEL READ COMMITTED';

/**
 * Runs a unit of work in one database transaction (plan 000 section 6.1). One pool connection
 * serves every attempt, so the pool's acquire timeout is waited at most once. A client whose
 * state the runner cannot account for is released with an error, so the pool destroys it.
 */
export class TransactionRunner<Client extends RunnerClient> {
  readonly #pool: RunnerPool<Client>;
  readonly #random: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: TransactionRunnerOptions<Client>) {
    this.#pool = options.pool;
    this.#random = options.random ?? Math.random;
    this.#sleep = options.sleep ?? ((ms) => delay(ms));
  }

  async run<T>(work: (client: Client) => Promise<T>, options: { retry: RetryPolicy }): Promise<T> {
    const client = await this.#pool.connect();
    const connection: { broken?: Error } = {};
    // pg-pool listens only on idle clients: while this run holds the client, a lost connection is
    // recorded here, so the client is destroyed on release and the process keeps running.
    const onError = (error: Error) => {
      connection.broken ??= error;
    };
    client.on('error', onError);
    try {
      return await this.#attempts(client, connection, work, options.retry);
    } finally {
      client.off('error', onError);
      client.release(connection.broken);
    }
  }

  async #attempts<T>(
    client: Client,
    connection: { broken?: Error },
    work: (client: Client) => Promise<T>,
    retry: RetryPolicy,
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await client.query(BEGIN);
        const result = await work(client);
        const commit = await client.query('COMMIT');
        // PostgreSQL answers COMMIT of a failed transaction with ROLLBACK, and no error.
        if (commit.command !== 'COMMIT') throw new Error('COMMIT did not commit the transaction');
        connection.broken ??= unaccounted(client);
        return result;
      } catch (error) {
        connection.broken ??= await rollBack(client);
        if (retry === 'movement' && isRetryable(error)) {
          // A broken connection cannot serve another attempt, so this one was the last (SYS-R19).
          if (connection.broken !== undefined || attempt >= MAX_ATTEMPTS) {
            throw new RetriesExhausted(attempt, { cause: error });
          }
          await this.#sleep(this.#random() * backoffBound(attempt));
          continue;
        }
        throw classifyDatabaseError(error, 'work');
      }
    }
  }
}

/** Rolls back; returns the reason the client cannot go back to the pool, if there is one. */
async function rollBack(client: RunnerClient): Promise<Error | undefined> {
  try {
    await client.query('ROLLBACK');
  } catch (error) {
    return new Error('ROLLBACK failed', { cause: error });
  }
  return unaccounted(client);
}

/** An error when the client is not idle outside a transaction, as it must be between attempts. */
function unaccounted(client: RunnerClient): Error | undefined {
  const status = client.getTransactionStatus();
  return status === 'I' ? undefined : new Error(`connection left in state ${String(status)}`);
}
