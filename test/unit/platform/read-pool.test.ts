import { sql } from 'kysely';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquiringPool, createDatabase } from '../../../src/platform/db/database.js';
import {
  ConnectionLost,
  PoolClosed,
  ProxyBorrowTimeout,
  StatementTimeout,
} from '../../../src/platform/db/errors.js';
import { toProblem } from '../../../src/platform/http/error-handler.js';
import {
  CLIENT_SIDE_LIMIT_MS,
  RequestContext,
  RequestDeadline,
  RequestTimeout,
} from '../../../src/platform/http/request-timeout.js';
import { WorkTracker } from '../../../src/platform/lifecycle/shutdown.js';
import { FakeClock } from '../../support/clock.js';
import { databaseError, type StatementPlan } from './runner-fakes.js';

/** A pooled connection for Kysely's reads, whose statements take injected time. */
class ReadClient {
  readonly statements: { text: string; sentAt: number; endedAt?: number }[] = [];
  readonly releases: { error: Error | undefined; at: number }[] = [];

  constructor(
    private readonly clock: FakeClock,
    private readonly plan: (text: string) => StatementPlan,
    /** Throws on every release after the first, as `pg` does on a double release. */
    private readonly strict = true,
  ) {}

  query(text: string): Promise<{ rows: unknown[]; rowCount: number; command: string }> {
    const record: { text: string; sentAt: number; endedAt?: number } = {
      text,
      sentAt: this.clock.now(),
    };
    this.statements.push(record);
    const { ms, outcome } = this.plan(text);
    return new Promise((resolve, reject) => {
      if (outcome === 'never') return;
      this.clock.setTimeout(() => {
        record.endedAt = this.clock.now();
        if (outcome instanceof Error) reject(outcome);
        else resolve({ rows: [{ n: 1 }], rowCount: 1, command: 'SELECT' });
      }, ms);
    });
  }

  release(error?: Error): void {
    this.releases.push({ error, at: this.clock.now() });
    if (this.strict && this.releases.length > 1) {
      throw new Error('Release called on client which has already been released to the pool.');
    }
  }
}

/** A Kysely instance over one read client, for a request whose deadline is 1000 ms away. */
function setup(options: { plan: (text: string) => StatementPlan; poolWaitMs?: number }) {
  const clock = new FakeClock();
  const client = new ReadClient(clock, options.plan);
  const pool = {
    connects: 0,
    connect(): Promise<pg.PoolClient> {
      this.connects += 1;
      return new Promise((resolve) => {
        clock.setTimeout(() => {
          resolve(client as unknown as pg.PoolClient);
        }, options.poolWaitMs ?? 0);
      });
    },
    end: () => Promise.resolve(),
  };
  const context = new RequestContext({
    deadline: new RequestDeadline(1000, clock),
    work: new WorkTracker(),
    destroyConnection: () => undefined,
  });
  const db = createDatabase(pool, () => context);
  return { clock, client, pool, db, context };
}

/** The outcome of a read once it settles, and when it settled. */
function outcome(read: Promise<unknown>, clock: FakeClock) {
  const state: { settled: boolean; value?: unknown; error?: unknown; at?: number } = {
    settled: false,
  };
  void read.then(
    (value) => Object.assign(state, { settled: true, value, at: clock.now() }),
    (error: unknown) => Object.assign(state, { settled: true, error, at: clock.now() }),
  );
  return state;
}

describe('the read pool', () => {
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => unhandled.push(reason);

  beforeEach(() => {
    unhandled.length = 0;
    process.on('unhandledRejection', record);
  });

  afterEach(() => {
    process.off('unhandledRejection', record);
    expect(unhandled).toEqual([]);
  });

  it('SEC-R33 answers RequestTimeout at the deadline while the statement in flight runs on, and gives the connection back only once it ends, without cancelling anything', async () => {
    const { clock, client, pool, db } = setup({ plan: () => ({ ms: 3000 }) });
    const state = outcome(sql`SELECT 1 AS n`.execute(db), clock);

    await clock.advanceTo(999);
    expect(state.settled).toBe(false);
    await clock.advanceTo(1000);
    expect(state.error).toBeInstanceOf(RequestTimeout);
    expect(state.at).toBe(1000);
    expect(client.releases).toEqual([]);

    await clock.advanceTo(3000);
    expect(client.statements).toEqual([{ text: 'SELECT 1 AS n', sentAt: 0, endedAt: 3000 }]);
    expect(client.releases).toEqual([{ error: undefined, at: 3000 }]);
    expect(pool.connects).toBe(1);
  });

  it('SEC-R33 starts no statement and takes no connection once the deadline passed', async () => {
    const { clock, client, pool, db } = setup({ plan: () => ({ ms: 0 }) });
    await clock.advanceTo(1000);
    const state = outcome(sql`SELECT 1 AS n`.execute(db), clock);
    await clock.advanceTo(1001);
    expect(state.error).toBeInstanceOf(RequestTimeout);
    expect(pool.connects).toBe(0);
    expect(client.statements).toEqual([]);
  });

  it('SEC-R33 answers at the deadline while the request waits for a pool connection, and releases one acquired after it unused', async () => {
    const { clock, client, db } = setup({ plan: () => ({ ms: 0 }), poolWaitMs: 1500 });
    const state = outcome(sql`SELECT 1 AS n`.execute(db), clock);
    await clock.advanceTo(1000);
    expect(state.error).toBeInstanceOf(RequestTimeout);
    await clock.advanceTo(1500);
    expect(client.statements).toEqual([]);
    expect(client.releases).toEqual([{ error: undefined, at: 1500 }]);
  });

  it('SEC-R33 destroys the connection when the statement in flight sends no reply within the client-side limit, and a late reply never releases it twice', async () => {
    const { clock, client, db } = setup({
      plan: () => ({ ms: 1000 + CLIENT_SIDE_LIMIT_MS + 500 }),
    });
    const state = outcome(sql`SELECT 1 AS n`.execute(db), clock);
    await clock.advanceTo(1000);
    expect(state.error).toBeInstanceOf(RequestTimeout);

    await clock.advanceTo(1000 + CLIENT_SIDE_LIMIT_MS - 1);
    expect(client.releases).toEqual([]);
    await clock.advanceTo(1000 + CLIENT_SIDE_LIMIT_MS);
    expect(client.releases).toHaveLength(1);
    expect(client.releases[0]?.error).toBeInstanceOf(Error);

    // The reply arrives after all: the connection is not released again.
    await clock.advanceTo(1000 + CLIENT_SIDE_LIMIT_MS + 500);
    expect(client.releases).toHaveLength(1);
  });

  it('SEC-R33 a release the pool refuses never surfaces as an unhandled rejection', async () => {
    const clock = new FakeClock();
    const client = new ReadClient(clock, () => ({ ms: 2000 }));
    const pool = {
      connect: () => Promise.resolve(client as unknown as pg.PoolClient),
      end: () => Promise.resolve(),
    };
    const context = new RequestContext({
      deadline: new RequestDeadline(1000, clock),
      work: new WorkTracker(),
      destroyConnection: () => undefined,
    });
    // The pool refuses the release, as it does for a client it already took back.
    client.release(new Error('released elsewhere'));
    const state = outcome(sql`SELECT 1 AS n`.execute(createDatabase(pool, () => context)), clock);
    await clock.advanceTo(1000);
    expect(state.error).toBeInstanceOf(RequestTimeout);
    await clock.advanceTo(2000);
    expect(client.releases).toHaveLength(2);
  });

  it('SEC-R32 a statement cancelled by statement_timeout is StatementTimeout, outside a request too', async () => {
    const clock = new FakeClock();
    const client = new ReadClient(clock, () => ({ ms: 10, outcome: databaseError('57014') }));
    const pool = {
      connect: () => Promise.resolve(client as unknown as pg.PoolClient),
      end: () => Promise.resolve(),
    };
    const state = outcome(sql`SELECT 1 AS n`.execute(createDatabase(pool)), clock);
    await clock.advanceTo(10);
    expect(state.error).toBeInstanceOf(StatementTimeout);
    expect(client.releases).toEqual([{ error: undefined, at: 10 }]);
  });

  it("SEC-AC39 a read that meets RDS Proxy's borrow timeout (08000) answers 503 with Retry-After: 1 and destroys its connection", async () => {
    const clock = new FakeClock();
    const borrowTimeout = databaseError('08000');
    borrowTimeout.message = 'Timed-out waiting to acquire database connection';
    const client = new ReadClient(clock, () => ({ ms: 5000, outcome: borrowTimeout }));
    const pool = {
      connect: () => Promise.resolve(client as unknown as pg.PoolClient),
      end: () => Promise.resolve(),
    };
    const state = outcome(sql`SELECT 1 AS n`.execute(createDatabase(pool)), clock);
    await clock.advanceTo(5000);

    expect(state.error).toBeInstanceOf(ProxyBorrowTimeout);
    const problem = toProblem(state.error);
    expect(problem.status).toBe(503);
    expect(problem.type).toBe('/problems/service-unavailable');
    expect(problem.headers['retry-after']).toBe('1');
    expect(client.statements).toHaveLength(1);
    expect(client.releases).toHaveLength(1);
    expect(client.releases[0]?.error).toBeInstanceOf(Error);
  });

  it('SYS-R34 a connection asked of a pool the shutdown already ended answers 503 with Retry-After, never 500', async () => {
    const pool = new pg.Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' });
    await pool.end();
    const counted: string[] = [];
    const requestPool = acquiringPool(pool, {
      poolAcquireTimeout: () => counted.push('acquire timeout'),
    });

    const error = await requestPool.connect().then(
      () => undefined,
      (refused: unknown) => refused,
    );

    expect(error).toBeInstanceOf(PoolClosed);
    const problem = toProblem(error);
    expect(problem.status).toBe(503);
    expect(problem.type).toBe('/problems/service-unavailable');
    expect(problem.headers['retry-after']).toBe('1');
    expect(counted).toEqual([]);
  });
  it('SEC-AC49 a read whose connection is lost answers 503 with Retry-After: 1 and destroys its connection', async () => {
    const { clock, client, db } = setup({
      plan: () => ({ ms: 10, outcome: new Error('Connection terminated unexpectedly') }),
    });
    const state = outcome(sql`SELECT 1 AS n`.execute(db), clock);
    await clock.advanceTo(10);
    expect(state.error).toBeInstanceOf(ConnectionLost);
    expect(toProblem(state.error)).toMatchObject({
      status: 503,
      type: '/problems/service-unavailable',
      headers: { 'retry-after': '1' },
    });
    expect(client.releases).toHaveLength(1);
    expect(client.releases[0]?.error).toBeInstanceOf(Error);
  });
});
