import { describe, expect, it } from 'vitest';
import { TransactionRunner } from '../../../src/platform/db/transaction-runner.js';
import { toProblem } from '../../../src/platform/http/error-handler.js';
import {
  CLIENT_SIDE_LIMIT_MS,
  RequestContext,
  RequestDeadline,
  RequestTimeout,
} from '../../../src/platform/http/request-timeout.js';
import { WorkTracker } from '../../../src/platform/lifecycle/shutdown.js';
import { FakeClock } from '../../support/clock.js';
import { databaseError, TimedClient, TimedPool, type StatementPlan } from './runner-fakes.js';

const BEGIN = 'BEGIN ISOLATION LEVEL READ COMMITTED';
const STATEMENTS = ['S1', 'S2', 'S3', 'S4', 'S5'];

/** A request of `timeoutMs` whose work runs through the runner on one timed client. */
function setup(options: {
  plan: (text: string) => StatementPlan;
  timeoutMs?: number;
  poolWaitMs?: number;
  random?: number;
}) {
  const clock = new FakeClock();
  const client = new TimedClient(clock, options.plan);
  const pool = new TimedPool(clock, client, options.poolWaitMs ?? 0);
  const runner = new TransactionRunner({
    pool,
    random: () => options.random ?? 0.5,
    sleep: (ms) => clock.sleep(ms),
  });
  const context = new RequestContext({
    deadline: new RequestDeadline(options.timeoutMs ?? 1000, clock),
    work: new WorkTracker(),
    destroyConnection: () => undefined,
  });
  return { clock, client, pool, runner, context };
}

/** The outcome of a run once it settles, and when it settled. */
function outcome(run: Promise<unknown>, clock: FakeClock) {
  const state: { settled: boolean; value?: unknown; error?: unknown; at?: number } = {
    settled: false,
  };
  void run.then(
    (value) => Object.assign(state, { settled: true, value, at: clock.now() }),
    (error: unknown) => Object.assign(state, { settled: true, error, at: clock.now() }),
  );
  return state;
}

/** Runs `statements` one after the other on the work's client. */
function work(statements: readonly string[]) {
  return async (client: TimedClient) => {
    for (const text of statements) await client.query(text);
  };
}

describe('the request timeout', () => {
  it('SEC-AC25 answers 503 at the deadline, lets the statement in flight end, starts no further statement and then rolls back, without cancelling anything', async () => {
    const { clock, client, pool, runner, context } = setup({
      plan: (text) => ({ ms: STATEMENTS.includes(text) ? 400 : 0 }),
    });
    const state = outcome(
      runner.run(work(STATEMENTS), { retry: 'movement', scope: context }),
      clock,
    );

    await clock.advanceTo(999);
    expect(state.settled).toBe(false);
    await clock.advanceTo(1000);
    expect(state.settled).toBe(true);
    expect(state.at).toBe(1000);
    expect(state.error).toBeInstanceOf(RequestTimeout);
    const problem = toProblem(state.error);
    expect(problem.status).toBe(503);
    expect(problem.type).toBe('/problems/service-unavailable');
    expect(problem.headers['retry-after']).toBe('1');
    // The third statement, sent at 800 ms, is still in flight.
    expect(client.texts()).toEqual([BEGIN, 'S1', 'S2', 'S3']);
    expect(client.releases).toEqual([]);

    await clock.advanceTo(1200);
    expect(client.statements[3]).toMatchObject({ text: 'S3', sentAt: 800, endedAt: 1200 });
    expect(client.texts()).toEqual([BEGIN, 'S1', 'S2', 'S3', 'ROLLBACK']);
    expect(client.statements[4]?.sentAt).toBe(1200);
    expect(client.releases).toEqual([{ error: undefined, at: 1200 }]);
    expect(pool.connects).toBe(1);
    expect(client.texts().some((text) => /cancel|terminate/i.test(text))).toBe(false);
  });

  it('SEC-R33 awaits the statement in flight whatever its outcome before ROLLBACK, and destroys the connection when ROLLBACK fails', async () => {
    for (const ending of ['answer', '57014', 'other error', 'rollback fails'] as const) {
      const { clock, client, runner, context } = setup({
        plan: (text) => {
          if (text === 'S1') {
            const outcomes = { '57014': databaseError('57014'), 'other error': new Error('boom') };
            const error =
              ending === '57014' || ending === 'other error' ? outcomes[ending] : undefined;
            return { ms: 3000, ...(error === undefined ? {} : { outcome: error }) };
          }
          if (text === 'ROLLBACK' && ending === 'rollback fails') {
            return { ms: 0, outcome: new Error('Connection terminated unexpectedly') };
          }
          return { ms: 0 };
        },
      });
      const state = outcome(
        runner.run(work(['S1', 'S2']), { retry: 'movement', scope: context }),
        clock,
      );

      await clock.advanceTo(1000);
      expect(state.error, ending).toBeInstanceOf(RequestTimeout);
      expect(client.texts(), ending).toEqual([BEGIN, 'S1']);
      await clock.advanceTo(2999);
      expect(client.texts(), ending).toEqual([BEGIN, 'S1']);
      await clock.advanceTo(3000);
      expect(client.texts(), ending).toEqual([BEGIN, 'S1', 'ROLLBACK']);
      expect(client.releases, ending).toHaveLength(1);
      if (ending === 'rollback fails') {
        expect(client.releases[0]?.error, ending).toBeInstanceOf(Error);
      } else {
        expect(client.releases[0]?.error, ending).toBeUndefined();
      }
    }
  });

  it('SEC-R33 refuses the next statement after the deadline and rolls back the open transaction; with no transaction open it sends nothing', async () => {
    // The deadline passes while the work runs no statement, between two of them.
    const { clock, client, runner, context } = setup({ plan: () => ({ ms: 0 }) });
    const state = outcome(
      runner.run(
        async (tx) => {
          await tx.query('S1');
          await clock.sleep(2000);
          await tx.query('S2');
        },
        { retry: 'movement', scope: context },
      ),
      clock,
    );
    await clock.advanceTo(1000);
    expect(state.error).toBeInstanceOf(RequestTimeout);
    await clock.advanceTo(2000);
    // S2 is refused before it is sent; the open transaction is rolled back.
    expect(client.texts()).toEqual([BEGIN, 'S1', 'ROLLBACK']);

    // A request whose deadline already passed starts nothing at all.
    const late = setup({ plan: () => ({ ms: 0 }) });
    await late.clock.advanceTo(1000);
    const refused = outcome(
      late.runner.run(work(['S1']), { retry: 'movement', scope: late.context }),
      late.clock,
    );
    await late.clock.advanceTo(1001);
    expect(refused.error).toBeInstanceOf(RequestTimeout);
    expect(late.client.texts()).toEqual([]);
    expect(late.pool.connects).toBe(0);
  });

  it('SEC-R33 answers at the deadline during the retry backoff, and sends no BEGIN after it', async () => {
    for (const sqlstate of ['40001', '40P01']) {
      // S1 fails after 998 ms; the backoff before the second attempt is 0.5 × 10 = 5 ms, across
      // the deadline.
      const { clock, client, runner, context } = setup({
        plan: (text) => (text === 'S1' ? { ms: 998, outcome: databaseError(sqlstate) } : { ms: 0 }),
      });
      const state = outcome(runner.run(work(['S1']), { retry: 'movement', scope: context }), clock);
      await clock.advanceTo(999);
      expect(client.texts(), sqlstate).toEqual([BEGIN, 'S1', 'ROLLBACK']);
      expect(state.settled, sqlstate).toBe(false);
      await clock.advanceTo(1000);
      expect(state.error, sqlstate).toBeInstanceOf(RequestTimeout);
      expect(state.at, sqlstate).toBe(1000);
      await clock.advanceTo(2000);
      expect(client.texts(), sqlstate).toEqual([BEGIN, 'S1', 'ROLLBACK']);
      // Released once the backoff ends, at 1003 ms, without another attempt.
      expect(client.releases, sqlstate).toEqual([{ error: undefined, at: 1003 }]);
    }
  });

  it('SEC-R33 answers at the deadline while the request waits for a pool connection, and releases one acquired after it unused', async () => {
    const { clock, client, runner, context } = setup({ plan: () => ({ ms: 0 }), poolWaitMs: 1500 });
    const state = outcome(runner.run(work(['S1']), { retry: 'movement', scope: context }), clock);
    await clock.advanceTo(1000);
    expect(state.error).toBeInstanceOf(RequestTimeout);
    expect(state.at).toBe(1000);
    await clock.advanceTo(1500);
    expect(client.texts()).toEqual([]);
    expect(client.releases).toEqual([{ error: undefined, at: 1500 }]);
  });

  it('SEC-R33 destroys the connection when the statement in flight sends no reply within the client-side limit', async () => {
    const { clock, client, runner, context } = setup({
      plan: (text) => (text === 'S1' ? { ms: 0, outcome: 'never' } : { ms: 0 }),
    });
    const state = outcome(runner.run(work(['S1']), { retry: 'movement', scope: context }), clock);
    await clock.advanceTo(1000);
    expect(state.error).toBeInstanceOf(RequestTimeout);
    expect(CLIENT_SIDE_LIMIT_MS).toBe(6000);
    await clock.advanceTo(1000 + CLIENT_SIDE_LIMIT_MS - 1);
    expect(client.releases).toEqual([]);
    await clock.advanceTo(1000 + CLIENT_SIDE_LIMIT_MS);
    expect(client.releases).toHaveLength(1);
    expect(client.releases[0]?.error).toBeInstanceOf(Error);
    expect(client.texts()).toEqual([BEGIN, 'S1']);
  });

  it('SEC-AC38 a COMMIT already sent at the deadline finishes after the 503, with no cancel and no ROLLBACK, and only then is the connection released', async () => {
    const { clock, client, pool, runner, context } = setup({
      plan: (text) => {
        if (text === 'S1') return { ms: 900 };
        if (text === 'COMMIT') return { ms: 500 };
        return { ms: 0 };
      },
    });
    const state = outcome(runner.run(work(['S1']), { retry: 'movement', scope: context }), clock);

    await clock.advanceTo(999);
    expect(state.settled).toBe(false);
    await clock.advanceTo(1000);
    expect(state.at).toBe(1000);
    expect(state.error).toBeInstanceOf(RequestTimeout);
    const problem = toProblem(state.error);
    expect(problem.status).toBe(503);
    expect(problem.type).toBe('/problems/service-unavailable');
    expect(problem.headers['retry-after']).toBe('1');
    expect(client.statements[2]).toMatchObject({ text: 'COMMIT', sentAt: 900 });
    expect(client.releases).toEqual([]);

    await clock.advanceTo(1400);
    expect(client.statements[2]?.endedAt).toBe(1400);
    expect(client.texts()).toEqual([BEGIN, 'S1', 'COMMIT']);
    expect(client.releases).toEqual([{ error: undefined, at: 1400 }]);
    expect(pool.connects).toBe(1);
    expect(client.texts().some((text) => /cancel|terminate|rollback/i.test(text))).toBe(false);
  });

  it('SEC-R27 a request is tracked until its response has closed, its reply was sent and every connection it held is released, in any order', () => {
    for (const order of [
      ['response closed', 'reply sent', 'connection released'],
      ['reply sent', 'response closed', 'connection released'],
      ['connection released', 'response closed', 'reply sent'],
    ]) {
      const clock = new FakeClock();
      const work = new WorkTracker();
      const context = new RequestContext({
        deadline: new RequestDeadline(1000, clock),
        work,
        destroyConnection: () => undefined,
      });
      const release = context.hold({ destroy: () => undefined });
      const steps: Record<string, () => void> = {
        'response closed': () => {
          context.responseClosed();
        },
        'reply sent': () => {
          context.replySent();
        },
        'connection released': release,
      };
      for (const [index, step] of order.entries()) {
        expect(work.size, `${order.join(', ')}: before ${step}`).toBe(1);
        steps[step]?.();
        if (index < order.length - 1)
          expect(work.size, `${order.join(', ')}: after ${step}`).toBe(1);
      }
      expect(work.size, order.join(', ')).toBe(0);
    }
  });

  it('SEC-R41 a request timeout tells whether the transaction had started, so a movement is counted as failed only once it reached the idempotency step', async () => {
    const waiting = setup({ plan: () => ({ ms: 0 }), poolWaitMs: 1500 });
    const beforeBegin = outcome(
      waiting.runner.run(work(['S1']), { retry: 'movement', scope: waiting.context }),
      waiting.clock,
    );
    await waiting.clock.advanceTo(1000);
    expect(beforeBegin.error).toBeInstanceOf(RequestTimeout);
    expect((beforeBegin.error as RequestTimeout).transactionStarted).toBe(false);

    const running = setup({ plan: (text) => ({ ms: text === 'S1' ? 3000 : 0 }) });
    const afterBegin = outcome(
      running.runner.run(work(['S1']), { retry: 'movement', scope: running.context }),
      running.clock,
    );
    await running.clock.advanceTo(1000);
    expect(afterBegin.error).toBeInstanceOf(RequestTimeout);
    expect((afterBegin.error as RequestTimeout).transactionStarted).toBe(true);
  });
});
