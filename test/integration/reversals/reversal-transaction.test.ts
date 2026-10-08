import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { IdempotentRunner } from '../../../src/modules/idempotency/application/idempotent-runner.js';
import type { AlreadyReversedCause } from '../../../src/modules/ledger/index.js';
import {
  Reversals,
  type MovementTransaction,
  type ReversalResult,
  type ReversalsOptions,
} from '../../../src/modules/movements/index.js';
import { AccountLockTimeout } from '../../../src/platform/db/errors.js';
import {
  balanceOf,
  closePools,
  createCustomerAccount,
  writeDirectDeposit,
} from '../../support/db.js';
import { openLockSession } from '../../support/sessions.js';
import { keyRowOf, recordingPool, SETTINGS, step, testPresenter } from '../idempotency/support.js';
import { C1, keyedMovementTransactions, OPERATOR, writtenRows } from '../movements/support.js';

const presenter = testPresenter<ReversalResult>(
  'req-keyed-reversal',
  (result) => `/v1/transactions/${result.transactionId}`,
);

/** One keyed reversal on a recorded connection, as the reversal route will run it (08-api). */
function runReversal(
  key: string,
  transactionId: string,
  options: { reversals?: ReversalsOptions; accountLockTimeoutMs?: number } = {},
) {
  const pool = recordingPool();
  const reversals = new Reversals(options.reversals);
  const answer = new IdempotentRunner(SETTINGS).run(
    keyedMovementTransactions(pool),
    { userId: OPERATOR.id, key, fingerprint: 'd'.repeat(64) },
    (tx: MovementTransaction) =>
      reversals.reverse(
        tx,
        { accountLockTimeoutMs: options.accountLockTimeoutMs ?? 4000 },
        {
          transactionId,
          reason: 'Operator correction',
          actor: OPERATOR,
          requestId: 'req-keyed-reversal',
        },
      ),
    presenter,
  );
  return { pool, answer };
}

const KEY_STEP = ['BEGIN', 'set_lock_timeout(2000)', 'key insert', 'SAVEPOINT'];

describe('keyed reversal transactions', () => {
  afterAll(async () => {
    await closePools();
  });

  it('REV-R17 a keyed reversal runs the skeleton in the order of plan 004 section 3: key row first, lookup, account lock timeout, locks, the existing-reversal check, the writes and the stored response', async () => {
    const a1 = await createCustomerAccount({ currency: 'EUR', ownerId: C1 });
    const d = await writeDirectDeposit(a1, '1000');

    const { pool, answer } = runReversal(`rev-${randomUUID()}`, d.transactionId);
    await expect(answer).resolves.toMatchObject({ replayed: false, response: { status: 201 } });
    expect(pool.statements.map(step)).toEqual([
      ...KEY_STEP,
      'select',
      'set_lock_timeout(4000)',
      'lock',
      'select',
      'insert into transactions',
      'insert into ledger_entries',
      'update accounts',
      'insert into audit_records',
      'key complete',
      'COMMIT',
    ]);
    expect(await balanceOf(a1.id)).toBe('0');
  });

  it('IDM-R14 REV-R06 a rejection rolls back to the savepoint and commits only the stored response, the 23505 of a second reversal included', async () => {
    const a1 = await createCustomerAccount({ currency: 'EUR', ownerId: C1 });
    const d = await writeDirectDeposit(a1, '1000');
    await writeDirectDeposit(a1, '1000');
    await expect(runReversal(`rev-${randomUUID()}`, d.transactionId).answer).resolves.toMatchObject(
      {
        response: { status: 201 },
      },
    );
    const before = await writtenRows();

    const checked = runReversal(`rev-${randomUUID()}`, d.transactionId);
    const refused: (AlreadyReversedCause | undefined)[] = [];
    const skipped: string[] = [];
    const constraint = runReversal(`rev-${randomUUID()}`, d.transactionId, {
      reversals: {
        skipExistingReversalCheck: {
          skips: (id) => {
            skipped.push(id);
            return true;
          },
          insertRefused: (cause) => refused.push(cause),
        },
      },
    });

    const byCheck = await checked.answer;
    const byConstraint = await constraint.answer;
    for (const { response } of [byCheck, byConstraint]) expect(response.status).toBe(409);
    expect(checked.pool.statements.map(step)).toEqual([
      ...KEY_STEP,
      'select',
      'set_lock_timeout(4000)',
      'lock',
      'select',
      'ROLLBACK TO SAVEPOINT',
      'key complete',
      'COMMIT',
    ]);
    expect(constraint.pool.statements.map(step)).toEqual([
      ...KEY_STEP,
      'select',
      'set_lock_timeout(4000)',
      'lock',
      'insert into transactions',
      'ROLLBACK TO SAVEPOINT',
      'key complete',
      'COMMIT',
    ]);
    expect(skipped).toEqual([d.transactionId]);
    expect(refused).toEqual([
      { sqlstate: '23505', constraint: 'transactions_reversed_transaction_id_key' },
    ]);
    for (const [{ pool }, { response }] of [
      [checked, byCheck],
      [constraint, byConstraint],
    ] as const) {
      const key = pool.statements.find((statement) => step(statement) === 'key insert')
        ?.values[1] as string;
      expect(await keyRowOf(OPERATOR.id, key)).toMatchObject({
        status: 409,
        body: Buffer.from(response.body),
      });
    }
    expect(await writtenRows()).toEqual(before);
    expect(await balanceOf(a1.id)).toBe('1000');
  });

  it('REV-R19 a lock timeout rolls back everything, key row included', async () => {
    const a1 = await createCustomerAccount({ currency: 'EUR', ownerId: C1 });
    const d = await writeDirectDeposit(a1, '1000');
    const key = `rev-${randomUUID()}`;
    const before = await writtenRows();
    const session = await openLockSession();
    try {
      await session.lockRow('accounts', a1.id);
      const { pool, answer } = runReversal(key, d.transactionId, { accountLockTimeoutMs: 200 });
      await expect(answer).rejects.toBeInstanceOf(AccountLockTimeout);
      expect(pool.statements.map(step).slice(-3)).toEqual([
        'set_lock_timeout(200)',
        'lock',
        'ROLLBACK',
      ]);
    } finally {
      await session.close();
    }
    expect(await keyRowOf(OPERATOR.id, key)).toBeUndefined();
    expect(await writtenRows()).toEqual(before);
    expect(await balanceOf(a1.id)).toBe('1000');
  });
});
