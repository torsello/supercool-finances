import { EventEmitter } from 'node:events';
import pg from 'pg';
import type { RunnerClient } from '../../../src/platform/db/transaction-runner.js';
import type { FakeClock } from '../../support/clock.js';

/** How a statement of the fake client ends: after `ms` of injected time, or never. */
export interface StatementPlan {
  ms: number;
  /** An error to fail with instead of answering; `'never'` never answers. */
  outcome?: Error | 'never';
}

/** A database error with a SQLSTATE, as `pg` raises it. */
export function databaseError(code: string): pg.DatabaseError {
  const error = new pg.DatabaseError(`fake ${code}`, 0, 'error');
  error.code = code;
  return error;
}

/**
 * A pooled connection whose statements take injected time: it records each statement with the
 * times it was sent and answered, its transaction status, and how it was released.
 */
export class TimedClient extends EventEmitter implements RunnerClient {
  readonly statements: { text: string; sentAt: number; endedAt?: number }[] = [];
  readonly releases: { error: Error | undefined; at: number }[] = [];
  #status = 'I';

  constructor(
    private readonly clock: FakeClock,
    private readonly plan: (text: string) => StatementPlan = () => ({ ms: 0 }),
  ) {
    super();
  }

  /** The texts sent, in order. */
  texts(): string[] {
    return this.statements.map((statement) => statement.text);
  }

  query(text: string): Promise<{ command: string }> {
    const record: { text: string; sentAt: number; endedAt?: number } = {
      text,
      sentAt: this.clock.now(),
    };
    this.statements.push(record);
    const { ms, outcome } = this.plan(text);
    return new Promise((resolve, reject) => {
      if (outcome === 'never') return;
      const answer = () => {
        record.endedAt = this.clock.now();
        if (outcome instanceof Error) {
          if (this.#status === 'T') this.#status = 'E';
          reject(outcome);
          return;
        }
        if (text.startsWith('BEGIN')) this.#status = 'T';
        if (text === 'COMMIT' || text === 'ROLLBACK') this.#status = 'I';
        resolve({ command: text.split(' ')[0] ?? '' });
      };
      if (ms === 0) answer();
      else this.clock.setTimeout(answer, ms);
    });
  }

  getTransactionStatus(): string | null {
    return this.#status;
  }

  release(error?: Error): void {
    this.releases.push({ error, at: this.clock.now() });
  }
}

/** A pool of one client that hands it out after `waitMs` of injected time, counting connects. */
export class TimedPool {
  connects = 0;

  constructor(
    private readonly clock: FakeClock,
    readonly client: TimedClient,
    private readonly waitMs = 0,
  ) {}

  connect(): Promise<TimedClient> {
    this.connects += 1;
    if (this.waitMs === 0) return Promise.resolve(this.client);
    return new Promise((resolve) => {
      this.clock.setTimeout(() => {
        resolve(this.client);
      }, this.waitMs);
    });
  }
}
