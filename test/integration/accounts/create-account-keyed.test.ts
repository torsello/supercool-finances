import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { KyselyAccountRepository } from '../../../src/modules/accounts/adapters/persistence/kysely-accounts.js';
import {
  createAccount,
  type AccountRecord,
  type AccountRepository,
} from '../../../src/modules/accounts/index.js';
import { IdempotentRunner } from '../../../src/modules/idempotency/application/idempotent-runner.js';
import { UuidV7Generator } from '../../../src/platform/ids/uuid-v7.js';
import { closePools, runtimePool } from '../../support/db.js';
import {
  keyedTransactions,
  keyRowOf,
  recordingPool,
  SETTINGS,
  step,
  testPresenter,
} from '../idempotency/support.js';

const ids = new UuidV7Generator();
const presenter = testPresenter<AccountRecord>(
  'req-keyed-account',
  (account) => `/v1/accounts/${account.id}`,
);

/**
 * Account creation with a key: the idempotency module's keyed transactions, never retried (plan
 * 000 section 6.1), with the account repository on the same connection as their operation.
 */
function createKeyed(ownerId: string, key: string) {
  const pool = recordingPool();
  const answer = new IdempotentRunner(SETTINGS).run(
    keyedTransactions(
      pool,
      (uow): { accounts: AccountRepository } => ({
        accounts: new KyselyAccountRepository(uow.db),
      }),
      'none',
    ),
    { userId: ownerId, key, fingerprint: 'e'.repeat(64) },
    (tx) => createAccount({ accounts: tx.accounts, ids }, { ownerId, currency: 'EUR' }),
    presenter,
  );
  return { pool, answer };
}

async function accountsOf(ownerId: string): Promise<string[]> {
  const result = await runtimePool().query<{ id: string }>(
    'SELECT id FROM accounts WHERE owner_id = $1 ORDER BY id',
    [ownerId],
  );
  return result.rows.map((row) => row.id);
}

describe('account creation with a key', () => {
  afterAll(async () => {
    await closePools();
  });

  it('ACC-R03 IDM-R02 runs inside the key step as the skeleton, with no lookup or lock, and stores the 201 with its Location', async () => {
    const c1 = randomUUID();
    const { pool, answer } = createKeyed(c1, 'k1');
    const { replayed, response } = await answer;

    expect(replayed).toBe(false);
    expect(pool.statements.map(step)).toEqual([
      'BEGIN',
      'set_lock_timeout(2000)',
      'key insert',
      'SAVEPOINT',
      'insert into accounts',
      'key complete',
      'COMMIT',
    ]);
    const [id] = await accountsOf(c1);
    expect(response.status).toBe(201);
    expect(response.headers.location).toBe(`/v1/accounts/${String(id)}`);
    expect(await keyRowOf(c1, 'k1')).toMatchObject({
      status: 201,
      headers: response.headers,
      body: Buffer.from(response.body),
    });
  });

  it('ACC-R03 a repeat with the same key returns the stored response and creates no account', async () => {
    const c1 = randomUUID();
    const first = await createKeyed(c1, 'k1').answer;
    const repeat = createKeyed(c1, 'k1');

    expect(await repeat.answer).toEqual({ replayed: true, response: first.response });
    expect(repeat.pool.statements.map(step)).not.toContain('insert into accounts');
    expect(await accountsOf(c1)).toHaveLength(1);
  });

  it('IDM-R02 IDM-R04 the same key of another user creates that user its own account', async () => {
    const c1 = randomUUID();
    const c2 = randomUUID();
    const mine = await createKeyed(c1, 'k1').answer;
    const theirs = await createKeyed(c2, 'k1').answer;

    expect(theirs.replayed).toBe(false);
    expect(theirs.response.headers.location).not.toBe(mine.response.headers.location);
    expect([await accountsOf(c1), await accountsOf(c2)].map((owned) => owned.length)).toEqual([
      1, 1,
    ]);
  });
});
