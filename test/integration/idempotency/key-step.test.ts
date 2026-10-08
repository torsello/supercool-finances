import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { IdempotentRunner } from '../../../src/modules/idempotency/application/idempotent-runner.js';
import { IdempotencyKeyReused } from '../../../src/modules/idempotency/index.js';
import { AccountLockTimeout, IdempotencyWaitTimeout } from '../../../src/platform/db/errors.js';
import type { UnitOfWork } from '../../../src/platform/db/unit-of-work.js';
import { closePools, runtimePool } from '../../support/db.js';
import { openLockSession } from '../../support/sessions.js';
import {
  expireKeyRow,
  jsonBytes,
  keyedTransactions,
  keyRowOf,
  recordingPool,
  Rejection,
  SETTINGS,
  step,
  testPresenter,
  waitUntilBlockedBy,
  type RecordingHooks,
} from './support.js';

const FP1 = 'a'.repeat(64);
const FP2 = 'b'.repeat(64);

/** The fake operation's result: the account it inserted. */
interface Created {
  id: string;
}

const presenter = testPresenter<Created>('req-key-step', (result) => `/v1/accounts/${result.id}`);

/** The fake operation: one write, an empty customer account, on the unit of work's connection. */
async function insertAccount(uow: UnitOfWork, id = randomUUID()): Promise<Created> {
  await uow.db
    .insertInto('accounts')
    .values({
      id,
      kind: 'customer',
      owner_id: randomUUID(),
      currency: 'EUR',
      status: 'active',
      balance: '0',
    })
    .execute();
  return { id };
}

async function accountExists(id: string): Promise<boolean> {
  const result = await runtimePool().query('SELECT 1 FROM accounts WHERE id = $1', [id]);
  return result.rowCount === 1;
}

function request(userId: string, key: string, fingerprint = FP1) {
  return { userId, key, fingerprint };
}

/** Runs one keyed request with the fake operation on a recorded connection. */
function runKeyed(
  keyed: { userId: string; key: string; fingerprint: string },
  options: {
    operation?: (uow: UnitOfWork) => Promise<Created>;
    hooks?: RecordingHooks;
    now?: () => number;
    pool?: ReturnType<typeof recordingPool>;
  } = {},
) {
  const pool = options.pool ?? recordingPool(runtimePool(), options.hooks);
  const runner = new IdempotentRunner(
    SETTINGS,
    options.now === undefined ? {} : { now: options.now },
  );
  const answer = runner.run(
    keyedTransactions(pool, (uow) => uow),
    keyed,
    options.operation ?? ((uow) => insertAccount(uow)),
    presenter,
  );
  return { pool, answer };
}

describe('the key step', () => {
  afterAll(async () => {
    await closePools();
  });

  it('IDM-R06 IDM-R11 IDM-R15 a first request sets the idempotency wait, inserts the key row as its first write, takes the savepoint, runs the operation and stores its 201 before the commit', async () => {
    const c1 = randomUUID();
    const accountId = randomUUID();
    const { pool, answer } = runKeyed(request(c1, 'k1'), {
      operation: (uow) => insertAccount(uow, accountId),
    });
    const { replayed, response } = await answer;

    expect(replayed).toBe(false);
    expect(response).toEqual({
      status: 201,
      headers: { 'content-type': 'application/json', location: `/v1/accounts/${accountId}` },
      body: jsonBytes({ id: accountId, requestId: 'req-key-step' }),
    });
    expect(pool.statements.map(step)).toEqual([
      'BEGIN',
      'set_lock_timeout(2000)',
      'key insert',
      'SAVEPOINT',
      'insert into accounts',
      'key complete',
      'COMMIT',
    ]);
    expect(pool.statements[2]?.values.slice(0, 4)).toEqual([c1, 'k1', FP1, 86400]);
    const row = await keyRowOf(c1, 'k1');
    expect(row).toMatchObject({
      fingerprint: FP1,
      status: 201,
      headers: response.headers,
      body: Buffer.from(response.body),
      ttl_seconds: '86400',
    });
    expect(await accountExists(accountId)).toBe(true);
  });

  it('IDM-R07 a repeat with the same fingerprint returns the stored bytes after a rollback and writes nothing', async () => {
    const c1 = randomUUID();
    const first = await runKeyed(request(c1, 'k1')).answer;
    const before = await keyRowOf(c1, 'k1');

    let calls = 0;
    const { pool, answer } = runKeyed(request(c1, 'k1'), {
      operation: (uow) => {
        calls += 1;
        return insertAccount(uow);
      },
    });
    const replay = await answer;

    expect(replay).toEqual({ replayed: true, response: first.response });
    expect(Buffer.from(replay.response.body).equals(Buffer.from(first.response.body))).toBe(true);
    expect(calls).toBe(0);
    expect(pool.statements.map(step)).toEqual([
      'BEGIN',
      'set_lock_timeout(2000)',
      'key insert',
      expect.stringMatching(/^set_lock_timeout\(\d+\)$/) as string,
      'key replace',
      'key read',
      'ROLLBACK',
    ]);
    expect(await keyRowOf(c1, 'k1')).toEqual(before);
  });

  it('IDM-R09 IDM-R04 another fingerprint of the same user and key is refused and the row is left unchanged; another user or key letter case is its own key', async () => {
    const c1 = randomUUID();
    await runKeyed(request(c1, 'k1')).answer;
    const before = await keyRowOf(c1, 'k1');

    const reused = runKeyed(request(c1, 'k1', FP2));
    await expect(reused.answer).rejects.toBeInstanceOf(IdempotencyKeyReused);
    expect(reused.pool.statements.map(step).at(-1)).toBe('ROLLBACK');
    expect(await keyRowOf(c1, 'k1')).toEqual(before);

    for (const keyed of [request(randomUUID(), 'k1', FP2), request(c1, 'K1', FP2)]) {
      await expect(runKeyed(keyed).answer).resolves.toMatchObject({ replayed: false });
    }
  });

  it('IDM-R21 an expired row is replaced, whatever its fingerprint, and the request runs as a first request', async () => {
    const c1 = randomUUID();
    await runKeyed(request(c1, 'k1')).answer;
    const old = await keyRowOf(c1, 'k1');
    await expireKeyRow(c1, 'k1');

    const accountId = randomUUID();
    const { pool, answer } = runKeyed(request(c1, 'k1', FP2), {
      operation: (uow) => insertAccount(uow, accountId),
    });
    const { replayed, response } = await answer;

    expect(replayed).toBe(false);
    expect(pool.statements.map(step)).toEqual([
      'BEGIN',
      'set_lock_timeout(2000)',
      'key insert',
      expect.stringMatching(/^set_lock_timeout\(\d+\)$/) as string,
      'key replace',
      'SAVEPOINT',
      'insert into accounts',
      'key complete',
      'COMMIT',
    ]);
    const row = await keyRowOf(c1, 'k1');
    expect(row).toMatchObject({
      fingerprint: FP2,
      status: 201,
      body: Buffer.from(response.body),
      ttl_seconds: '86400',
    });
    expect(row?.created_at).not.toBe(old?.created_at);
    expect(await accountExists(accountId)).toBe(true);
  });

  it('IDM-R21 when the cleanup deletes the expired row right after step 3, the request goes back to step 3, claims the key and runs as a first request', async () => {
    const c1 = randomUUID();
    await runKeyed(request(c1, 'k1')).answer;
    await expireKeyRow(c1, 'k1');

    let deleted = 0;
    const { pool, answer } = runKeyed(request(c1, 'k1', FP2), {
      hooks: {
        async after(statement, result) {
          if (step(statement) !== 'key insert' || result.rowCount !== 0 || deleted > 0) return;
          // A separate session, as the cleanup, deletes the expired row between steps 3 and 3b.
          const cleanup = await runtimePool().query(
            'DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2 AND expires_at <= now()',
            [c1, 'k1'],
          );
          deleted = cleanup.rowCount ?? 0;
        },
      },
    });
    const { replayed, response } = await answer;

    expect(deleted).toBe(1);
    expect(replayed).toBe(false);
    expect(pool.statements.map(step)).toEqual([
      'BEGIN',
      'set_lock_timeout(2000)',
      'key insert',
      expect.stringMatching(/^set_lock_timeout\(\d+\)$/) as string,
      'key replace',
      'key read',
      expect.stringMatching(/^set_lock_timeout\(\d+\)$/) as string,
      'key insert',
      'SAVEPOINT',
      'insert into accounts',
      'key complete',
      'COMMIT',
    ]);
    expect(await keyRowOf(c1, 'k1')).toMatchObject({
      fingerprint: FP2,
      status: 201,
      body: Buffer.from(response.body),
    });
  });

  it('IDM-R11 IDM-R12 a wait at step 3 and then at step 3b shares one key-wait budget of 2000 ms and ends with IdempotencyWaitTimeout', async () => {
    const c1 = randomUUID();
    await runKeyed(request(c1, 'k1')).answer;
    await expireKeyRow(c1, 'k1');
    const replace = `UPDATE idempotency_keys SET fingerprint = $3, status = NULL, headers = NULL,
      body = NULL, created_at = now(), expires_at = now() + interval '1 day'
      WHERE user_id = $1 AND key = $2`;

    const second = await openLockSession();
    const third = await openLockSession();
    try {
      // Another session replaces the expired row and holds it, so step 3 waits for it.
      await second.lock(replace, [c1, 'k1', FP2]);

      const readings: number[] = [];
      let sentStep2: number | undefined;
      let thirdBlocks: Promise<void> | undefined;
      const pool = recordingPool(runtimePool(), {
        before(statement) {
          sentStep2 ??=
            step(statement) === 'set_lock_timeout(2000)' ? performance.now() : undefined;
        },
        async after(statement, result) {
          if (step(statement) !== 'key insert' || result.rowCount !== 0 || thirdBlocks) return;
          // Step 3 found the expired row once the second session rolled back. A third session
          // replaces it before step 3b, so step 3b waits for it.
          await third.lock(replace, [c1, 'k1', FP2]);
          thirdBlocks = third.waitUntilBlocked(await pool.pid());
        },
      });
      const { answer } = runKeyed(request(c1, 'k1'), {
        pool,
        now: () => {
          const reading = performance.now();
          readings.push(reading);
          return reading;
        },
      });
      const outcome = answer.then(
        () => undefined,
        (error: unknown) => error,
      );

      await second.waitUntilBlocked(await pool.pid());
      await second.release();
      const error = await outcome;
      const finished = performance.now();

      expect(error).toBeInstanceOf(IdempotencyWaitTimeout);
      await expect(thirdBlocks).resolves.toBeUndefined();
      expect(pool.statements.map(step)).toEqual([
        'BEGIN',
        'set_lock_timeout(2000)',
        'key insert',
        expect.stringMatching(/^set_lock_timeout\(\d+\)$/) as string,
        'key replace',
        'ROLLBACK',
      ]);
      // Deterministic: the lock_timeout of step 3b is the whole ms left before the deadline of
      // step 2, so the time step 3 used and the wait allowed at step 3b sum to at most 2000 ms.
      const [atStep2, before3b] = readings;
      if (atStep2 === undefined || before3b === undefined) throw new Error('clock not read');
      const values = pool.statements
        .filter((statement) => statement.text.startsWith('SELECT app.set_lock_timeout'))
        .map((statement) => statement.values[0] as number);
      expect(values).toEqual([2000, Math.floor(atStep2 + 2000 - before3b)]);
      expect(before3b - atStep2 + (values[1] ?? Infinity)).toBeLessThanOrEqual(2000);
      // The only wall-clock assertion, a generous one.
      expect(finished - (sentStep2 ?? 0)).toBeLessThan(4000);
    } finally {
      await second.close();
      await third.close();
    }
  });

  it('IDM-R10 a second request with the same key waits for the first and then replays its stored result', async () => {
    const c1 = randomUUID();
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let claimed: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      claimed = resolve;
    });
    const first = runKeyed(request(c1, 'k1'), {
      operation: async (uow) => {
        const created = await insertAccount(uow);
        claimed();
        await gate;
        return created;
      },
    });
    // The first request holds the key row before the second one starts.
    await running;
    const second = runKeyed(request(c1, 'k1'));
    await waitUntilBlockedBy(await second.pool.pid(), await first.pool.pid());
    open();

    const [one, two] = await Promise.all([first.answer, second.answer]);
    expect(one.replayed).toBe(false);
    expect(two).toEqual({ replayed: true, response: one.response });
    expect(second.pool.statements.map(step)).not.toContain('SAVEPOINT');
  });

  it('IDM-R10 a second request with the same key runs as a first request when the first rolls back', async () => {
    const c1 = randomUUID();
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const failed = randomUUID();
    let claimed: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      claimed = resolve;
    });
    const first = runKeyed(request(c1, 'k1'), {
      operation: async (uow) => {
        await insertAccount(uow, failed);
        claimed();
        await gate;
        throw new Error('fault after the first write');
      },
    });
    await running;
    const ran = randomUUID();
    const second = runKeyed(request(c1, 'k1'), {
      operation: (uow) => insertAccount(uow, ran),
    });
    await waitUntilBlockedBy(await second.pool.pid(), await first.pool.pid());
    open();

    await expect(first.answer).rejects.toThrow('fault after the first write');
    const { replayed, response } = await second.answer;
    expect(replayed).toBe(false);
    expect(await keyRowOf(c1, 'k1')).toMatchObject({
      status: 201,
      body: Buffer.from(response.body),
    });
    expect([await accountExists(failed), await accountExists(ran)]).toEqual([false, true]);
  });

  it('IDM-R14 a stored rejection rolls back to the savepoint and commits only the key row with the problem response', async () => {
    const c1 = randomUUID();
    const accountId = randomUUID();
    const { pool, answer } = runKeyed(request(c1, 'k1'), {
      operation: async (uow) => {
        await insertAccount(uow, accountId);
        throw new Rejection(422, '/problems/insufficient-funds');
      },
    });
    const { replayed, response } = await answer;

    expect(replayed).toBe(false);
    expect(response.status).toBe(422);
    expect(pool.statements.map(step).slice(-5)).toEqual([
      'SAVEPOINT',
      'insert into accounts',
      'ROLLBACK TO SAVEPOINT',
      'key complete',
      'COMMIT',
    ]);
    expect(await keyRowOf(c1, 'k1')).toMatchObject({
      status: 422,
      headers: { 'content-type': 'application/problem+json' },
      body: Buffer.from(response.body),
    });
    expect(await accountExists(accountId)).toBe(false);
  });

  it('IDM-R16 IDM-R17 a validation error, a 500 and a 503 roll back everything and leave no key row', async () => {
    for (const failure of [
      new Rejection(422, '/problems/validation-error'),
      new Error('defect'),
      new AccountLockTimeout({ cause: undefined }),
    ]) {
      const c1 = randomUUID();
      const accountId = randomUUID();
      const { pool, answer } = runKeyed(request(c1, 'k1'), {
        operation: async (uow) => {
          await insertAccount(uow, accountId);
          throw failure;
        },
      });
      await expect(answer).rejects.toBe(failure);
      expect(pool.statements.map(step).slice(-3)).toEqual([
        'SAVEPOINT',
        'insert into accounts',
        'ROLLBACK',
      ]);
      expect(await keyRowOf(c1, 'k1')).toBeUndefined();
      expect(await accountExists(accountId)).toBe(false);
    }
  });
});
