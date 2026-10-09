import { EventEmitter } from 'node:events';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  AccountLockTimeout,
  IdempotencyWaitTimeout,
  RetriesExhausted,
} from '../../../src/platform/db/errors.js';
import { toProblem } from '../../../src/platform/http/error-handler.js';
import {
  backoffBound,
  TransactionRunner,
  type RunnerClient,
  type TransactionObserver,
} from '../../../src/platform/db/transaction-runner.js';

function databaseError(code: string): pg.DatabaseError {
  const error = new pg.DatabaseError(`fake ${code}`, 0, 'error');
  error.code = code;
  return error;
}

/** A fake pooled connection that records its statements and how it was released. */
class FakeClient extends EventEmitter implements RunnerClient {
  readonly statements: string[] = [];
  readonly releases: (Error | undefined)[] = [];
  status: string | null = 'I';
  failRollback = false;
  commitTag = 'COMMIT';

  query(text: string): Promise<{ command: string }> {
    this.statements.push(text);
    if (text === 'ROLLBACK' && this.failRollback) {
      return Promise.reject(new Error('Connection terminated unexpectedly'));
    }
    return Promise.resolve({
      command: text === 'COMMIT' ? this.commitTag : (text.split(' ')[0] ?? ''),
    });
  }

  getTransactionStatus(): string | null {
    return this.status;
  }

  release(error?: Error): void {
    this.releases.push(error);
  }
}

function setup(random = 0.5) {
  const client = new FakeClient();
  const connects: FakeClient[] = [];
  const delays: number[] = [];
  const runner = new TransactionRunner({
    pool: {
      connect: () => {
        connects.push(client);
        return Promise.resolve(client);
      },
    },
    random: () => random,
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
  });
  return { client, connects, delays, runner };
}

const BEGIN = 'BEGIN ISOLATION LEVEL READ COMMITTED';

describe('transaction runner', () => {
  it('SYS-R18 bounds the wait before retries 1 to 7 at 10, 20, 40, 80, 160, 200 and 200 ms', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(backoffBound)).toEqual([10, 20, 40, 80, 160, 200, 200]);
  });

  it('SYS-R18 waits random × bound: 0 ms with the random source at 0, below the bound at 0.999', async () => {
    for (const [random, low, high] of [
      [0, 0, 0],
      [0.5, 5, 5],
      [0.999, 9.9, 9.999],
    ] as const) {
      const { runner, delays } = setup(random);
      let attempts = 0;
      await runner.run(
        () => {
          attempts += 1;
          return attempts === 1 ? Promise.reject(databaseError('40P01')) : Promise.resolve('ok');
        },
        { retry: 'movement' },
      );
      expect(delays).toHaveLength(1);
      expect(delays[0]).toBeGreaterThanOrEqual(low);
      expect(delays[0]).toBeLessThanOrEqual(high);
      expect(delays[0]).toBeLessThan(backoffBound(1));
    }
  });

  it('SYS-R18 runs twice a unit of work whose first attempt fails with 40P01, after one delay of 5 ms, and returns the second result', async () => {
    const { runner, client, connects, delays } = setup(0.5);
    let attempts = 0;
    const result = await runner.run(
      () => {
        attempts += 1;
        return attempts === 1 ? Promise.reject(databaseError('40P01')) : Promise.resolve(attempts);
      },
      { retry: 'movement' },
    );
    expect(result).toBe(2);
    expect(delays).toEqual([5]);
    expect(client.statements).toEqual([BEGIN, 'ROLLBACK', BEGIN, 'COMMIT']);
    expect(connects).toHaveLength(1);
    expect(client.releases).toEqual([undefined]);
  });

  it('SYS-R18 SYS-R19 runs a unit of work that always fails with 40001 exactly 3 times, waits 5 and 10 ms, and ends with RetriesExhausted', async () => {
    const { runner, client, delays } = setup(0.5);
    let attempts = 0;
    const failure = databaseError('40001');
    const outcome = runner.run(
      () => {
        attempts += 1;
        return Promise.reject(failure);
      },
      { retry: 'movement' },
    );
    await expect(outcome).rejects.toBeInstanceOf(RetriesExhausted);
    await expect(outcome).rejects.toMatchObject({ attempts: 3, cause: failure });
    expect(attempts).toBe(3);
    expect(delays).toEqual([5, 10]);
    expect(client.statements.filter((statement) => statement === 'ROLLBACK')).toHaveLength(3);
    expect(client.releases).toEqual([undefined]);
  });

  it('SYS-R18 retries a 40001 raised by COMMIT', async () => {
    const { runner, client, delays } = setup(0.5);
    let commits = 0;
    const query = client.query.bind(client);
    client.query = (text: string) => {
      if (text === 'COMMIT' && commits++ === 0) {
        client.statements.push(text);
        return Promise.reject(databaseError('40001'));
      }
      return query(text);
    };
    await expect(runner.run(() => Promise.resolve('done'), { retry: 'movement' })).resolves.toBe(
      'done',
    );
    expect(delays).toEqual([5]);
    expect(client.statements).toEqual([BEGIN, 'COMMIT', 'ROLLBACK', BEGIN, 'COMMIT']);
  });

  it('SYS-R18 never retries any other SQLSTATE, such as 23505', async () => {
    const { runner, delays } = setup(0.5);
    let attempts = 0;
    const failure = databaseError('23505');
    await expect(
      runner.run(
        () => {
          attempts += 1;
          return Promise.reject(failure);
        },
        { retry: 'movement' },
      ),
    ).rejects.toBe(failure);
    expect(attempts).toBe(1);
    expect(delays).toEqual([]);
  });

  it('SYS-R18 never retries with retry "none", which account creation and status changes use', async () => {
    const { runner, delays } = setup(0.5);
    let attempts = 0;
    const failure = databaseError('40P01');
    await expect(
      runner.run(
        () => {
          attempts += 1;
          return Promise.reject(failure);
        },
        { retry: 'none' },
      ),
    ).rejects.toBe(failure);
    expect(attempts).toBe(1);
    expect(delays).toEqual([]);
  });

  it('SYS-AC16 retries 40P01 and 40001 within the bound, and maps the exhausted retry to 503 service-unavailable with Retry-After: 1', async () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(backoffBound)).toEqual([10, 20, 40, 80, 160, 200, 200]);

    for (const [random, check] of [
      [
        0,
        (delay: number) => {
          expect(delay).toBe(0);
        },
      ],
      [
        0.999,
        (delay: number) => {
          expect(delay).toBeLessThan(backoffBound(1));
        },
      ],
    ] as const) {
      const { runner, delays } = setup(random);
      let attempts = 0;
      await runner.run(
        () => {
          attempts += 1;
          return attempts === 1 ? Promise.reject(databaseError('40P01')) : Promise.resolve();
        },
        { retry: 'movement' },
      );
      expect(delays).toHaveLength(1);
      check(delays[0] ?? Number.NaN);
    }

    const deadlock = setup(0.5);
    let deadlockAttempts = 0;
    const second = await deadlock.runner.run(
      () => {
        deadlockAttempts += 1;
        return deadlockAttempts === 1
          ? Promise.reject(databaseError('40P01'))
          : Promise.resolve('second attempt');
      },
      { retry: 'movement' },
    );
    expect(second).toBe('second attempt');
    expect(deadlockAttempts).toBe(2);
    expect(deadlock.delays).toEqual([5]);

    const serialization = setup(0.5);
    let serializationAttempts = 0;
    const exhausted = await serialization.runner
      .run(
        () => {
          serializationAttempts += 1;
          return Promise.reject(databaseError('40001'));
        },
        { retry: 'movement' },
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(serializationAttempts).toBe(3);
    expect(serialization.delays).toEqual([5, 10]);
    expect(exhausted).toBeInstanceOf(RetriesExhausted);
    expect(toProblem(exhausted)).toMatchObject({
      status: 503,
      type: '/problems/service-unavailable',
      headers: { 'retry-after': '1' },
    });

    const other = setup(0.5);
    let otherAttempts = 0;
    const unique = databaseError('23505');
    await expect(
      other.runner.run(
        () => {
          otherAttempts += 1;
          return Promise.reject(unique);
        },
        { retry: 'movement' },
      ),
    ).rejects.toBe(unique);
    expect(otherAttempts).toBe(1);
    expect(other.delays).toEqual([]);
  });

  it('SYS-R11 releases the client with an error, so the pool destroys it, when ROLLBACK fails', async () => {
    const { runner, client } = setup();
    client.failRollback = true;
    const failure = new Error('work failed');
    await expect(runner.run(() => Promise.reject(failure), { retry: 'movement' })).rejects.toBe(
      failure,
    );
    expect(client.releases).toHaveLength(1);
    expect(client.releases[0]).toBeInstanceOf(Error);
  });

  it('SYS-R11 SYS-R19 does not retry a 40P01 on a connection whose ROLLBACK failed, and ends with RetriesExhausted', async () => {
    const { runner, client, delays } = setup();
    client.failRollback = true;
    let attempts = 0;
    const failure = databaseError('40P01');
    const outcome = runner.run(
      () => {
        attempts += 1;
        return Promise.reject(failure);
      },
      { retry: 'movement' },
    );
    await expect(outcome).rejects.toBeInstanceOf(RetriesExhausted);
    await expect(outcome).rejects.toMatchObject({ attempts: 1, cause: failure });
    expect(attempts).toBe(1);
    expect(delays).toEqual([]);
    expect(client.releases[0]).toBeInstanceOf(Error);
  });

  it('SYS-R11 releases the client with an error when the connection reports a transaction still open or aborted after ROLLBACK', async () => {
    for (const status of ['T', 'E', null]) {
      const { runner, client } = setup();
      const failure = new Error('work failed');
      const query = client.query.bind(client);
      client.query = async (text: string) => {
        const result = await query(text);
        if (text === 'ROLLBACK') client.status = status;
        return result;
      };
      await expect(runner.run(() => Promise.reject(failure), { retry: 'none' })).rejects.toBe(
        failure,
      );
      expect(client.releases).toHaveLength(1);
      expect(client.releases[0]).toBeInstanceOf(Error);
    }
  });

  it('SYS-R11 releases the client with an error when the connection reports an unknown state after COMMIT', async () => {
    const { runner, client } = setup();
    const query = client.query.bind(client);
    client.query = async (text: string) => {
      const result = await query(text);
      if (text === 'COMMIT') client.status = 'T';
      return result;
    };
    await expect(runner.run(() => Promise.resolve('done'), { retry: 'none' })).resolves.toBe(
      'done',
    );
    expect(client.releases[0]).toBeInstanceOf(Error);
  });

  it('SYS-R11 fails, and never reports success, when COMMIT answers that the transaction was rolled back', async () => {
    const { runner, client } = setup();
    client.commitTag = 'ROLLBACK';
    await expect(runner.run(() => Promise.resolve('done'), { retry: 'movement' })).rejects.toThrow(
      'COMMIT did not commit',
    );
    expect(client.statements).toEqual([BEGIN, 'COMMIT', 'ROLLBACK']);
    expect(client.releases).toEqual([undefined]);
  });

  it('SYS-R11 releases the client with the error it emitted while the run held it, and removes its listener', async () => {
    const { runner, client } = setup();
    const lost = new Error('Connection terminated unexpectedly');
    const failure = new Error('statement failed');
    await expect(
      runner.run(
        () => {
          client.emit('error', lost);
          return Promise.reject(failure);
        },
        { retry: 'movement' },
      ),
    ).rejects.toBe(failure);
    expect(client.releases).toEqual([lost]);
    expect(client.listenerCount('error')).toBe(0);
  });

  it('SYS-R11 returns a healthy client to the pool after a failed attempt', async () => {
    const { runner, client } = setup();
    const failure = new Error('work failed');
    await expect(runner.run(() => Promise.reject(failure), { retry: 'none' })).rejects.toBe(
      failure,
    );
    expect(client.statements).toEqual([BEGIN, 'ROLLBACK']);
    expect(client.releases).toEqual([undefined]);
  });

  it('SEC-R41 counts a lock timeout only when its wait ended with SQLSTATE 55P03, as table 1.4 of spec 007 defines it', async () => {
    const counted: string[] = [];
    const observer: TransactionObserver = {
      retried: () => undefined,
      retriesExhausted: () => undefined,
      lockTimeout: (lock) => {
        counted.push(lock);
      },
    };
    const client = new FakeClient();
    const runner = new TransactionRunner({
      pool: { connect: () => Promise.resolve(client) },
      observer,
    });
    for (const error of [
      new IdempotencyWaitTimeout({ cause: databaseError('55P03') }),
      // The key-wait deadline ran out without a lock wait: answered 409, not counted.
      new IdempotencyWaitTimeout(),
      new AccountLockTimeout({ cause: databaseError('55P03') }),
    ]) {
      await expect(runner.run(() => Promise.reject(error), { retry: 'movement' })).rejects.toBe(
        error,
      );
    }
    expect(counted).toEqual(['idempotency', 'account']);
  });
});
