import { describe, expect, it } from 'vitest';
import { TransactionRunner } from '../../../src/platform/db/transaction-runner.js';
import {
  RequestContext,
  RequestDeadline,
  RequestTimeout,
} from '../../../src/platform/http/request-timeout.js';
import { WorkTracker } from '../../../src/platform/lifecycle/shutdown.js';
import { FakeClock } from '../../support/clock.js';
import { TimedClient, TimedPool } from './runner-fakes.js';
import { coordinator, watch } from './shutdown-fakes.js';

describe('the shutdown coordinator', () => {
  it('SEC-AC21 at SHUTDOWN_TIMEOUT_MS a request still in flight has its connection destroyed and its transaction rolled back, then the pool, the readiness connection and Redis close in order, and the exit code is 1', async () => {
    const clock = new FakeClock();
    const tracker = new WorkTracker();
    const calls: string[] = [];
    // A request that never finishes.
    tracker.add({
      destroyConnection: () => calls.push('connection destroyed'),
      rollBack: () => calls.push('transaction rolled back'),
    });

    const state = watch(
      coordinator(clock, tracker, calls, { drainDelayMs: 0, timeoutMs: 1000 }).shutdown('SIGTERM'),
    );

    await clock.advanceTo(999);
    expect(calls).toEqual(['readiness 503', 'stopped accepting', 'idle connections closed']);
    expect(state.code).toBeUndefined();

    await clock.advanceTo(1000);
    expect(calls).toEqual([
      'readiness 503',
      'stopped accepting',
      'idle connections closed',
      'connection destroyed',
      'transaction rolled back',
      'pool closed',
      'readiness connection closed',
      'redis closed',
    ]);
    expect(state.code).toBe(1);
  });

  it('SEC-R25 SEC-R27 keeps serving for the drain delay, then waits for the requests in flight, closes everything in order and exits 0', async () => {
    const clock = new FakeClock();
    const tracker = new WorkTracker();
    const calls: string[] = [];
    const finish = tracker.add({
      destroyConnection: () => calls.push('connection destroyed'),
      rollBack: () => calls.push('transaction rolled back'),
    });
    const state = watch(
      coordinator(clock, tracker, calls, { drainDelayMs: 500, timeoutMs: 1000 }).shutdown(
        'SIGTERM',
      ),
    );

    await clock.advanceTo(499);
    expect(calls).toEqual(['readiness 503']);
    await clock.advanceTo(500);
    expect(calls).toEqual(['readiness 503', 'stopped accepting', 'idle connections closed']);
    await clock.advanceTo(1200);
    finish();
    await clock.advanceTo(1201);
    expect(calls.slice(3)).toEqual(['pool closed', 'readiness connection closed', 'redis closed']);
    expect(state.code).toBe(0);
  });

  /**
   * A request answered 503 at its request timeout (1000 ms of injected time) while its only
   * statement, sent at 0, takes `statementMs` or never answers; the shutdown starts at 1000 ms
   * with a drain delay of 0.
   */
  async function timedOutRequest(statement: { ms: number } | 'never', timeoutMs: number) {
    const clock = new FakeClock();
    const tracker = new WorkTracker();
    const client = new TimedClient(clock, (text) =>
      text === 'UPDATE accounts'
        ? statement === 'never'
          ? { ms: 0, outcome: 'never' }
          : { ms: statement.ms }
        : { ms: 0 },
    );
    const runner = new TransactionRunner({ pool: new TimedPool(clock, client) });
    const destroyed: string[] = [];
    const context = new RequestContext({
      deadline: new RequestDeadline(1000, clock),
      work: tracker,
      destroyConnection: () => destroyed.push('http connection destroyed'),
    });
    const answered = runner
      .run(
        async (tx) => {
          await tx.query('UPDATE accounts');
        },
        { retry: 'movement', scope: context },
      )
      .then(
        () => 'committed',
        (error: unknown) => error,
      );
    await clock.advanceTo(1000);
    expect(await answered).toBeInstanceOf(RequestTimeout);
    // The 503 was sent: the HTTP response is over, the clean-up is not.
    context.replySent();
    context.responseClosed();
    expect(tracker.size).toBe(1);

    const calls: string[] = [];
    const state = watch(
      coordinator(clock, tracker, calls, { drainDelayMs: 0, timeoutMs }).shutdown('SIGTERM'),
    );
    return { clock, client, calls, state, destroyed };
  }

  it('SEC-R27 a clean-up after a request-timeout 503 keeps the coordinator waiting, which exits 0 once it ends before SHUTDOWN_TIMEOUT_MS', async () => {
    const { clock, client, calls, state } = await timedOutRequest({ ms: 3000 }, 5000);

    await clock.advanceTo(2999);
    expect(state.code).toBeUndefined();
    expect(calls).not.toContain('pool closed');

    await clock.advanceTo(3000);
    expect(client.texts()).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      'UPDATE accounts',
      'ROLLBACK',
    ]);
    expect(client.releases).toEqual([{ error: undefined, at: 3000 }]);
    expect(calls.slice(-3)).toEqual(['pool closed', 'readiness connection closed', 'redis closed']);
    expect(state.code).toBe(0);
  });

  it('SEC-R28 a clean-up still running at SHUTDOWN_TIMEOUT_MS is cut off: its connection is destroyed and the exit code is 1', async () => {
    const { clock, client, calls, state, destroyed } = await timedOutRequest('never', 2000);

    await clock.advanceTo(2999);
    expect(state.code).toBeUndefined();
    expect(client.releases).toEqual([]);

    await clock.advanceTo(3000);
    expect(destroyed).toEqual(['http connection destroyed']);
    expect(client.releases).toHaveLength(1);
    expect(client.releases[0]?.error).toBeInstanceOf(Error);
    expect(client.texts()).not.toContain('COMMIT');
    expect(calls.slice(-3)).toEqual(['pool closed', 'readiness connection closed', 'redis closed']);
    expect(state.code).toBe(1);
  });
});
