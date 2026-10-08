import { EventEmitter } from 'node:events';
import { sql, type Kysely } from 'kysely';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { IdempotentRunner } from '../../../src/modules/idempotency/application/idempotent-runner.js';
import type {
  KeyClaim,
  KeyedTransactions,
  KeyRow,
  KeyStore,
  Presenter,
} from '../../../src/modules/idempotency/application/ports.js';
import {
  IdempotencyKeyReused,
  type StoredResponse,
} from '../../../src/modules/idempotency/index.js';
import { AccountLockTimeout, IdempotencyWaitTimeout } from '../../../src/platform/db/errors.js';
import type { Database } from '../../../src/platform/db/schema.js';
import {
  TransactionRunner,
  type RunnerClient,
} from '../../../src/platform/db/transaction-runner.js';
import { UnitOfWork } from '../../../src/platform/db/unit-of-work.js';
import { toProblem } from '../../../src/platform/http/error-handler.js';

function databaseError(code: string): pg.DatabaseError {
  const error = new pg.DatabaseError(`fake ${code}`, 0, 'error');
  error.code = code;
  return error;
}

/**
 * A fake pooled connection: it records every statement and fails the ones `fails` picks with the
 * SQLSTATE it returns, as PostgreSQL would.
 */
class FakeClient extends EventEmitter implements RunnerClient {
  readonly statements: string[] = [];
  /** The parameters of each `app.set_lock_timeout` call, in order. */
  readonly lockTimeouts: unknown[] = [];
  fails: (text: string) => string | undefined = () => undefined;

  query(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ command: string; rowCount: number; rows: unknown[] }> {
    this.statements.push(text);
    if (text === SET_LOCK_TIMEOUT) this.lockTimeouts.push(values[0]);
    const code = this.fails(text);
    if (code !== undefined) return Promise.reject(databaseError(code));
    return Promise.resolve({ command: text.split(' ')[0] ?? '', rowCount: 0, rows: [] });
  }

  getTransactionStatus(): string | null {
    return 'I';
  }

  release(): void {
    // The fake has no pool to go back to.
  }
}

const RESPONSE: StoredResponse = {
  status: 201,
  headers: { 'content-type': 'application/json', location: '/v1/transactions/t1' },
  body: Buffer.from('{"id":"t1"}'),
};

/**
 * A fake key store: each call sends one statement naming its step, so the fake connection can fail
 * it, and answers from what the test scripted.
 */
class FakeKeyStore implements KeyStore {
  claims: boolean[] = [true];
  expiredClaims: boolean[] = [false];
  rows: (KeyRow | undefined)[] = [];
  readonly completed: StoredResponse[] = [];

  constructor(private readonly db: () => Kysely<Database>) {}

  async claim(claim: KeyClaim): Promise<boolean> {
    expect(claim.ttlSeconds).toBe(86400);
    await sql`SELECT 'key: claim'`.execute(this.db());
    return this.claims.shift() ?? false;
  }

  async claimExpired(): Promise<boolean> {
    await sql`SELECT 'key: claim expired'`.execute(this.db());
    return this.expiredClaims.shift() ?? false;
  }

  async read(): Promise<KeyRow | undefined> {
    await sql`SELECT 'key: read'`.execute(this.db());
    return this.rows.shift();
  }

  async complete(_userId: string, _key: string, response: StoredResponse): Promise<void> {
    await sql`SELECT 'key: complete'`.execute(this.db());
    this.completed.push(response);
  }
}

/** The fake operation's port: one account lock, as step 7 of a movement takes it. */
interface FakeOperation {
  lockAccount(): Promise<void>;
  setLockTimeout(ms: number): Promise<void>;
}

class Rejected extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
  ) {
    super(type);
  }
}

const presenter: Presenter<string> = {
  created: (id) => ({ ...RESPONSE, body: Buffer.from(`{"id":"${id}"}`) }),
  problem: (error) => {
    const [status, type] =
      error instanceof Rejected
        ? [error.status, error.type]
        : error instanceof AccountLockTimeout
          ? [503, '/problems/service-unavailable']
          : [500, '/problems/internal-error'];
    return {
      status,
      type,
      headers: { 'content-type': 'application/problem+json' },
      body: Buffer.from(`{"type":"${type}"}`),
    };
  },
};

const REQUEST = { userId: 'c1', key: 'k1', fingerprint: 'f'.repeat(64) };
const SETTINGS = { waitTimeoutMs: 2000, keyTtlSeconds: 86400 };

const BEGIN = 'BEGIN ISOLATION LEVEL READ COMMITTED';
const SET_LOCK_TIMEOUT = 'SELECT app.set_lock_timeout($1::integer)';
const CLAIM = "SELECT 'key: claim'";
const CLAIM_EXPIRED = "SELECT 'key: claim expired'";
const READ = "SELECT 'key: read'";
const COMPLETE = "SELECT 'key: complete'";
const LOCK = 'SELECT id FROM accounts WHERE id = $1 FOR UPDATE';

/**
 * The real transaction runner and unit of work over the fake connection, with the fake key store
 * and operation on the unit of work's statements, so lock timeouts are classified where the
 * service classifies them (plan 000 section 6.3).
 */
function setup(clock?: number[]) {
  const client = new FakeClient();
  const delays: number[] = [];
  const runner = new TransactionRunner({
    pool: { connect: () => Promise.resolve(client) },
    random: () => 0.5,
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
  });
  let current: UnitOfWork | undefined;
  const keys = new FakeKeyStore(() => {
    if (current === undefined) throw new Error('no unit of work');
    return current.db;
  });
  const transactions: KeyedTransactions<FakeOperation> = {
    run: async (work) =>
      await runner.run(
        async (connection) => {
          // The fake answers the statements the unit of work's Kysely instance sends.
          const uow = new UnitOfWork(connection as unknown as pg.ClientBase);
          current = uow;
          return await work({
            keys,
            keyWait: (statements) => uow.keyWait(statements),
            setLockTimeout: (ms) => uow.setLockTimeout(ms),
            savepoint: () => uow.savepoint('work'),
            rollbackToSavepoint: () => uow.rollbackToSavepoint('work'),
            operation: {
              lockAccount: async () => {
                await sql`SELECT id FROM accounts WHERE id = ${'a1'} FOR UPDATE`.execute(uow.db);
              },
              setLockTimeout: (ms) => uow.setLockTimeout(ms),
            },
          });
        },
        { retry: 'movement' },
      ),
  };
  const readings = clock === undefined ? undefined : [...clock];
  const idempotent = new IdempotentRunner(SETTINGS, {
    ...(readings === undefined
      ? {}
      : {
          now: () => {
            const reading = readings.shift();
            if (reading === undefined) throw new Error('the clock was read more than scripted');
            return reading;
          },
        }),
  });
  const run = (operation: (tx: FakeOperation) => Promise<string> = () => Promise.resolve('t1')) =>
    idempotent.run(transactions, REQUEST, operation, presenter);
  return { client, delays, keys, run };
}

describe('idempotent runner', () => {
  it('IDM-R12 a 55P03 at the key insert ends in IdempotencyWaitTimeout, rolls back everything and is not retried', async () => {
    const { client, delays, run } = setup();
    client.fails = (text) => (text === CLAIM ? '55P03' : undefined);
    const operation = { calls: 0 };
    await expect(
      run(() => {
        operation.calls += 1;
        return Promise.resolve('t1');
      }),
    ).rejects.toBeInstanceOf(IdempotencyWaitTimeout);
    expect(client.statements).toEqual([BEGIN, SET_LOCK_TIMEOUT, CLAIM, 'ROLLBACK']);
    expect(operation.calls).toBe(0);
    expect(delays).toEqual([]);
  });

  it('IDM-R12 a 55P03 at step 3b, at step 3c or at a re-pass also ends in IdempotencyWaitTimeout', async () => {
    for (const [failing, rows] of [
      [CLAIM_EXPIRED, []],
      [READ, []],
      // A re-pass: step 3c found no row, so the request goes back to step 3, which times out.
      [CLAIM, [undefined]],
    ] as const) {
      const { client, keys, run } = setup();
      keys.claims = [false];
      keys.rows = [...rows];
      let seen = 0;
      client.fails = (text) => {
        if (text !== failing) return undefined;
        seen += 1;
        return failing === CLAIM && seen === 1 ? undefined : '55P03';
      };
      await expect(run(), failing).rejects.toBeInstanceOf(IdempotencyWaitTimeout);
      expect(client.statements.at(-1)).toBe('ROLLBACK');
      expect(client.statements.filter((text) => text === BEGIN)).toHaveLength(1);
      expect(client.statements).not.toContain('COMMIT');
    }
  });

  it('IDM-R13 a 55P03 at an account lock after the key insert ends in AccountLockTimeout, rolls back everything, key row included, and is not retried', async () => {
    const { client, delays, keys, run } = setup();
    client.fails = (text) => (text === LOCK ? '55P03' : undefined);
    await expect(
      run(async (tx) => {
        await tx.setLockTimeout(4000);
        await tx.lockAccount();
        return 't1';
      }),
    ).rejects.toBeInstanceOf(AccountLockTimeout);
    expect(client.statements).toEqual([
      BEGIN,
      SET_LOCK_TIMEOUT,
      CLAIM,
      'SAVEPOINT "work"',
      SET_LOCK_TIMEOUT,
      LOCK,
      'ROLLBACK',
    ]);
    expect(keys.completed).toEqual([]);
    expect(delays).toEqual([]);
  });

  it('IDM-AC14 a 55P03 at the key insert and one at an account lock after it end in the typed errors toProblem maps to 409 request-in-progress and 503 service-unavailable, each with Retry-After: 1, both rolled back entirely and neither retried', async () => {
    const atKey = setup();
    atKey.client.fails = (text) => (text === CLAIM ? '55P03' : undefined);
    const keyError: unknown = await atKey.run().catch((error: unknown) => error);
    expect(keyError).toBeInstanceOf(IdempotencyWaitTimeout);
    expect(toProblem(keyError)).toMatchObject({
      status: 409,
      type: '/problems/request-in-progress',
      headers: { 'retry-after': '1' },
    });
    expect(atKey.client.statements).toEqual([BEGIN, SET_LOCK_TIMEOUT, CLAIM, 'ROLLBACK']);
    expect(atKey.delays).toEqual([]);

    const atLock = setup();
    atLock.client.fails = (text) => (text === LOCK ? '55P03' : undefined);
    const lockError: unknown = await atLock
      .run(async (tx) => {
        await tx.setLockTimeout(4000);
        await tx.lockAccount();
        return 't1';
      })
      .catch((error: unknown) => error);
    expect(lockError).toBeInstanceOf(AccountLockTimeout);
    expect(toProblem(lockError)).toMatchObject({
      status: 503,
      type: '/problems/service-unavailable',
      headers: { 'retry-after': '1' },
    });
    expect(atLock.client.statements).toEqual([
      BEGIN,
      SET_LOCK_TIMEOUT,
      CLAIM,
      'SAVEPOINT "work"',
      SET_LOCK_TIMEOUT,
      LOCK,
      'ROLLBACK',
    ]);
    expect(atLock.client.statements).not.toContain('COMMIT');
    expect(atLock.keys.completed).toEqual([]);
    expect(atLock.delays).toEqual([]);
  });

  it('IDM-R15 a first request runs the key step, the savepoint and the operation, stores the 201 and commits', async () => {
    const { client, keys, run } = setup();
    const answer = await run(async (tx) => {
      await tx.lockAccount();
      return 't9';
    });
    expect(answer).toEqual({
      replayed: false,
      response: { ...RESPONSE, body: Buffer.from('{"id":"t9"}') },
    });
    expect(keys.completed).toEqual([answer.response]);
    expect(client.statements).toEqual([
      BEGIN,
      SET_LOCK_TIMEOUT,
      CLAIM,
      'SAVEPOINT "work"',
      LOCK,
      COMPLETE,
      'COMMIT',
    ]);
  });

  it('IDM-R07 a row with the same fingerprint is replayed after a rollback, without the operation', async () => {
    const { client, keys, run } = setup();
    keys.claims = [false];
    keys.rows = [{ fingerprint: REQUEST.fingerprint, response: RESPONSE, expired: false }];
    let calls = 0;
    const answer = await run(() => {
      calls += 1;
      return Promise.resolve('t1');
    });
    expect(answer).toEqual({ replayed: true, response: RESPONSE });
    expect(calls).toBe(0);
    expect(client.statements).toEqual([
      BEGIN,
      SET_LOCK_TIMEOUT,
      CLAIM,
      SET_LOCK_TIMEOUT,
      CLAIM_EXPIRED,
      READ,
      'ROLLBACK',
    ]);
  });

  it('IDM-R09 a row with another fingerprint ends in IdempotencyKeyReused after a rollback', async () => {
    const { client, keys, run } = setup();
    keys.claims = [false];
    keys.rows = [{ fingerprint: 'e'.repeat(64), response: RESPONSE, expired: false }];
    await expect(run()).rejects.toBeInstanceOf(IdempotencyKeyReused);
    expect(client.statements.at(-1)).toBe('ROLLBACK');
    expect(keys.completed).toEqual([]);
  });

  it('IDM-R14 a stored rejection rolls back to the savepoint, stores the problem and commits', async () => {
    const { client, keys, run } = setup();
    const answer = await run(async (tx) => {
      await tx.lockAccount();
      throw new Rejected(422, '/problems/insufficient-funds');
    });
    expect(answer.replayed).toBe(false);
    expect(answer.response.status).toBe(422);
    expect(keys.completed).toEqual([answer.response]);
    expect(client.statements.slice(-4)).toEqual([
      LOCK,
      'ROLLBACK TO SAVEPOINT "work"',
      COMPLETE,
      'COMMIT',
    ]);
  });

  it('IDM-R16 IDM-R17 a validation error and a 500 roll back everything and store nothing', async () => {
    for (const error of [new Rejected(422, '/problems/validation-error'), new Error('boom')]) {
      const { client, keys, run } = setup();
      await expect(run(() => Promise.reject(error))).rejects.toBe(error);
      expect(client.statements.slice(-2)).toEqual(['SAVEPOINT "work"', 'ROLLBACK']);
      expect(keys.completed).toEqual([]);
    }
  });

  it('IDM-R17 a 40001 at the key insert re-runs the whole attempt, key insert included', async () => {
    const { client, delays, run } = setup();
    let failures = 1;
    client.fails = (text) => {
      if (text !== CLAIM || failures === 0) return undefined;
      failures -= 1;
      return '40001';
    };
    await expect(run()).resolves.toMatchObject({ replayed: false });
    expect(client.statements).toEqual([
      BEGIN,
      SET_LOCK_TIMEOUT,
      CLAIM,
      'ROLLBACK',
      BEGIN,
      SET_LOCK_TIMEOUT,
      CLAIM,
      'SAVEPOINT "work"',
      COMPLETE,
      'COMMIT',
    ]);
    expect(delays).toEqual([5]);
  });

  it('IDM-R10 IDM-R12 with the key-wait budget used up before step 3b, skips step 3b only and still reads the row: a live row with the same fingerprint is replayed, one with another fingerprint is refused', async () => {
    for (const [fingerprint, outcome] of [
      [REQUEST.fingerprint, 'replay'],
      ['e'.repeat(64), 'reused'],
    ] as const) {
      // At step 2, then at the deadline before step 3b: less than 1 ms left.
      const { client, keys, run } = setup([1000, 3000]);
      keys.claims = [false];
      keys.rows = [{ fingerprint, response: RESPONSE, expired: false }];
      if (outcome === 'replay') {
        await expect(run()).resolves.toEqual({ replayed: true, response: RESPONSE });
      } else {
        await expect(run()).rejects.toBeInstanceOf(IdempotencyKeyReused);
      }
      expect(client.lockTimeouts).toEqual([2000]);
      expect(client.statements).toEqual([BEGIN, SET_LOCK_TIMEOUT, CLAIM, READ, 'ROLLBACK']);
    }
  });

  it('IDM-R12 with the key-wait budget used up before step 3b, a missing or expired row ends in IdempotencyWaitTimeout', async () => {
    for (const row of [
      undefined,
      { fingerprint: REQUEST.fingerprint, response: RESPONSE, expired: true },
    ]) {
      const { client, keys, run } = setup([1000, 2999.5]);
      keys.claims = [false];
      keys.rows = [row];
      await expect(run()).rejects.toBeInstanceOf(IdempotencyWaitTimeout);
      expect(client.lockTimeouts).toEqual([2000]);
      expect(client.statements).toEqual([BEGIN, SET_LOCK_TIMEOUT, CLAIM, READ, 'ROLLBACK']);
    }
  });

  it('IDM-R11 IDM-R12 sets lock_timeout before step 3b and each re-pass to the whole ms left before the deadline, and ends in IdempotencyWaitTimeout with less than 1 ms left', async () => {
    // Readings of the monotonic clock: at step 2, then before each lock_timeout of a key-wait step.
    const { client, keys, run } = setup([1000, 1500, 2200.4, 2300.9, 2999.5]);
    keys.claims = [false, false];
    keys.rows = [
      undefined,
      { fingerprint: REQUEST.fingerprint, response: RESPONSE, expired: true },
    ];
    await expect(run()).rejects.toBeInstanceOf(IdempotencyWaitTimeout);
    // 2000 at step 2; then 3000 − 1500, 3000 − 2200.4 and 3000 − 2300.9, rounded down.
    expect(client.lockTimeouts).toEqual([2000, 1500, 799, 699]);
    expect(client.statements).toEqual([
      BEGIN,
      SET_LOCK_TIMEOUT,
      CLAIM,
      SET_LOCK_TIMEOUT,
      CLAIM_EXPIRED,
      READ,
      SET_LOCK_TIMEOUT,
      CLAIM,
      SET_LOCK_TIMEOUT,
      CLAIM_EXPIRED,
      READ,
      // 0.5 ms left before the next pass: no statement, IdempotencyWaitTimeout at once.
      'ROLLBACK',
    ]);
  });
});
