import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { IdempotentRunner } from '../../../src/modules/idempotency/application/idempotent-runner.js';
import {
  deposit,
  transfer,
  withdraw,
  type MovementResult,
  type MovementTransaction,
} from '../../../src/modules/movements/index.js';
import { AccountLockTimeout, IdempotencyWaitTimeout } from '../../../src/platform/db/errors.js';
import {
  balanceOf,
  closePools,
  createCustomerAccount,
  runtimePool,
  writeDirectDeposit,
} from '../../support/db.js';
import { openLockSession } from '../../support/sessions.js';
import {
  keyRowOf,
  recordingPool,
  SETTINGS,
  step,
  testPresenter,
  type RecordingPool,
} from '../idempotency/support.js';
import { C1, C2, customer, keyedMovementTransactions, OPERATOR, writtenRows } from './support.js';

/** An account lock timeout other than the idempotency wait, to tell the two calls apart. */
const ACCOUNT_LOCK = { accountLockTimeoutMs: 4000 };

const presenter = testPresenter<MovementResult>(
  'req-keyed',
  (result) => `/v1/transactions/${result.transactionId}`,
);

/** One keyed movement on a recorded connection, as a movement route will run it (08-api). */
function runMovement(
  userId: string,
  key: string,
  operation: (tx: MovementTransaction) => Promise<MovementResult>,
  options: { pool?: RecordingPool; waitTimeoutMs?: number } = {},
) {
  const pool = options.pool ?? recordingPool();
  const runner = new IdempotentRunner({
    ...SETTINGS,
    waitTimeoutMs: options.waitTimeoutMs ?? SETTINGS.waitTimeoutMs,
  });
  const answer = runner.run(
    keyedMovementTransactions(pool),
    { userId, key, fingerprint: 'c'.repeat(64) },
    operation,
    presenter,
  );
  return { pool, answer };
}

const KEY_STEP = ['BEGIN', 'set_lock_timeout(2000)', 'key insert', 'SAVEPOINT'];
const KEY_END = ['key complete', 'COMMIT'];

describe('keyed movement transactions', () => {
  afterAll(async () => {
    await closePools();
  });

  it('MOV-R06 MOV-R19 IDM-R11 each movement runs the skeleton in order: the idempotency wait, the key row as first write, the savepoint, the lookup, the account lock timeout right before the first FOR UPDATE, the writes and the stored response', async () => {
    const a1 = await createCustomerAccount({ currency: 'EUR', ownerId: C1 });
    const b1 = await createCustomerAccount({ currency: 'EUR', ownerId: C2 });
    await writeDirectDeposit(a1, '1000');

    const deposited = runMovement(OPERATOR.id, `dep-${randomUUID()}`, (tx) =>
      deposit(tx, ACCOUNT_LOCK, {
        accountId: a1.id,
        amount: 100n,
        currency: 'EUR',
        actor: OPERATOR,
        requestId: 'req-keyed',
      }),
    );
    const withdrawn = runMovement(C1, `wd-${randomUUID()}`, (tx) =>
      withdraw(tx, ACCOUNT_LOCK, {
        accountId: a1.id,
        amount: 100n,
        currency: 'EUR',
        actor: customer(C1),
        requestId: 'req-keyed',
      }),
    );
    const transferred = runMovement(C1, `tr-${randomUUID()}`, (tx) =>
      transfer(tx, ACCOUNT_LOCK, {
        accountId: a1.id,
        destinationAccountId: b1.id,
        amount: 100n,
        currency: 'EUR',
        actor: customer(C1),
        requestId: 'req-keyed',
      }),
    );
    for (const { answer } of [deposited, withdrawn, transferred]) {
      await expect(answer).resolves.toMatchObject({ replayed: false, response: { status: 201 } });
    }

    const oneAccount = [
      ...KEY_STEP,
      'select',
      'set_lock_timeout(4000)',
      'lock',
      'insert into transactions',
      'insert into ledger_entries',
      'update accounts',
      'insert into audit_records',
      ...KEY_END,
    ];
    expect(deposited.pool.statements.map(step)).toEqual(oneAccount);
    expect(withdrawn.pool.statements.map(step)).toEqual(oneAccount);
    expect(transferred.pool.statements.map(step)).toEqual([
      ...KEY_STEP,
      'select',
      'set_lock_timeout(4000)',
      'lock',
      'lock',
      'insert into transactions',
      'insert into ledger_entries',
      'update accounts',
      'update accounts',
      'insert into audit_records',
      ...KEY_END,
    ]);
    for (const { pool } of [deposited, withdrawn, transferred]) {
      const steps = pool.statements.map(step);
      const firstWrite = steps.findIndex((name) => /^(key insert|insert|update|delete)/.test(name));
      expect(steps[firstWrite]).toBe('key insert');
      expect(steps[firstWrite - 1]).toBe('set_lock_timeout(2000)');
      expect(steps[steps.indexOf('lock') - 1]).toBe('set_lock_timeout(4000)');
    }
    expect([await balanceOf(a1.id), await balanceOf(b1.id)]).toEqual(['900', '100']);
  });

  it('MOV-R29 a key insert that waits beyond the idempotency wait timeout ends with IdempotencyWaitTimeout, never AccountLockTimeout, and writes nothing', async () => {
    const a1 = await createCustomerAccount({ currency: 'EUR', ownerId: C1 });
    await writeDirectDeposit(a1, '1000');
    const key = `wd-${randomUUID()}`;
    const before = await writtenRows();
    const session = await openLockSession();
    try {
      // Another request's key row, inserted and not yet committed: the insert of step 3 waits.
      await session.lock(
        `INSERT INTO idempotency_keys (user_id, key, fingerprint, created_at, expires_at)
         VALUES ($1, $2, repeat('c', 64), now(), now() + interval '1 day')`,
        [C1, key],
      );
      const { answer } = runMovement(
        C1,
        key,
        (tx) =>
          withdraw(tx, ACCOUNT_LOCK, {
            accountId: a1.id,
            amount: 100n,
            currency: 'EUR',
            actor: customer(C1),
            requestId: 'req-keyed',
          }),
        { waitTimeoutMs: 200 },
      );
      await expect(answer).rejects.toBeInstanceOf(IdempotencyWaitTimeout);
    } finally {
      await session.close();
    }
    expect(await writtenRows()).toEqual(before);
    expect(await balanceOf(a1.id)).toBe('1000');
    expect(await keyRowOf(C1, key)).toBeUndefined();
  });

  it('IDM-R14 a lookup rejection and a business rejection roll back to the savepoint and commit only the stored response, with no transaction, entry, balance change or audit record', async () => {
    const a1 = await createCustomerAccount({ currency: 'EUR', ownerId: C1 });
    await writeDirectDeposit(a1, '1000');
    const before = await writtenRows();

    const missing = runMovement(C1, `wd-${randomUUID()}`, (tx) =>
      withdraw(tx, ACCOUNT_LOCK, {
        accountId: randomUUID(),
        amount: 100n,
        currency: 'EUR',
        actor: customer(C1),
        requestId: 'req-keyed',
      }),
    );
    const tooMuch = runMovement(C1, `wd-${randomUUID()}`, (tx) =>
      withdraw(tx, ACCOUNT_LOCK, {
        accountId: a1.id,
        amount: 1500n,
        currency: 'EUR',
        actor: customer(C1),
        requestId: 'req-keyed',
      }),
    );
    const notFound = await missing.answer;
    const refused = await tooMuch.answer;

    expect(notFound.response.status).toBe(404);
    expect(refused.response.status).toBe(422);
    expect(missing.pool.statements.map(step)).toEqual([
      ...KEY_STEP,
      'select',
      'ROLLBACK TO SAVEPOINT',
      ...KEY_END,
    ]);
    expect(tooMuch.pool.statements.map(step)).toEqual([
      ...KEY_STEP,
      'select',
      'set_lock_timeout(4000)',
      'lock',
      'ROLLBACK TO SAVEPOINT',
      ...KEY_END,
    ]);
    for (const [{ pool }, { response }] of [
      [missing, notFound],
      [tooMuch, refused],
    ] as const) {
      const keyInsert = pool.statements.find((statement) => step(statement) === 'key insert');
      const key = keyInsert?.values[1] as string;
      expect(await keyRowOf(C1, key)).toMatchObject({
        status: response.status,
        body: Buffer.from(response.body),
      });
    }
    expect(await writtenRows()).toEqual(before);
    expect(await balanceOf(a1.id)).toBe('1000');
  });

  it('MOV-R20 MOV-R21 an account lock timeout rolls back everything, key row included, and a second run with the same key is a first request', async () => {
    const a1 = await createCustomerAccount({ currency: 'EUR', ownerId: C1 });
    await writeDirectDeposit(a1, '1000');
    const key = `wd-${randomUUID()}`;
    const before = await writtenRows();
    const withdrawal = (tx: MovementTransaction) =>
      withdraw(
        tx,
        { accountLockTimeoutMs: 200 },
        {
          accountId: a1.id,
          amount: 100n,
          currency: 'EUR',
          actor: customer(C1),
          requestId: 'req-keyed',
        },
      );

    const session = await openLockSession();
    try {
      await session.lockRow('accounts', a1.id);
      const timedOut = runMovement(C1, key, withdrawal);
      await expect(timedOut.answer).rejects.toBeInstanceOf(AccountLockTimeout);
      expect(timedOut.pool.statements.map(step).slice(-3)).toEqual([
        'set_lock_timeout(200)',
        'lock',
        'ROLLBACK',
      ]);
    } finally {
      await session.close();
    }
    expect(await keyRowOf(C1, key)).toBeUndefined();
    expect(await writtenRows()).toEqual(before);
    expect(await balanceOf(a1.id)).toBe('1000');

    const retried = runMovement(C1, key, withdrawal);
    await expect(retried.answer).resolves.toMatchObject({
      replayed: false,
      response: { status: 201 },
    });
    expect(retried.pool.statements.map(step).slice(0, 3)).toEqual([
      'BEGIN',
      'set_lock_timeout(2000)',
      'key insert',
    ]);
    expect(await balanceOf(a1.id)).toBe('900');
    const result = await runtimePool().query<{ count: string }>(
      `SELECT count(*) FROM audit_records WHERE action = 'withdrawal' AND $1 = ANY (account_ids)`,
      [a1.id],
    );
    expect(result.rows[0]?.count).toBe('1');
  });
});
