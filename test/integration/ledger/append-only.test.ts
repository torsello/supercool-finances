import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closePools,
  createCustomerAccount,
  ownerPool,
  rejection,
  runtimePool,
  writeDirectDeposit,
} from '../../support/db.js';

async function snapshot(transactionId: string): Promise<unknown> {
  const transaction = await runtimePool().query(
    'SELECT id, kind, currency, reversed_transaction_id, created_at FROM transactions WHERE id = $1',
    [transactionId],
  );
  const entries = await runtimePool().query(
    `SELECT id, account_id, amount, currency, created_at FROM ledger_entries
     WHERE transaction_id = $1 ORDER BY id`,
    [transactionId],
  );
  return { transaction: transaction.rows, entries: entries.rows };
}

describe('append-only ledger', () => {
  let t1 = '';
  let a1 = '';

  beforeAll(async () => {
    const account = await createCustomerAccount({ currency: 'EUR' });
    a1 = account.id;
    t1 = (await writeDirectDeposit(account, '1000')).transactionId;
  });

  afterAll(async () => {
    await closePools();
  });

  it('LED-AC11 transactions and ledger entries cannot be changed by the runtime or owner role', async () => {
    const before = await snapshot(t1);
    const statements = [
      `UPDATE ledger_entries SET amount = 2000 WHERE transaction_id = '${t1}' AND account_id = '${a1}'`,
      `DELETE FROM ledger_entries WHERE transaction_id = '${t1}' AND account_id = '${a1}'`,
      `UPDATE transactions SET kind = 'withdrawal' WHERE id = '${t1}'`,
      `DELETE FROM transactions WHERE id = '${t1}'`,
      'TRUNCATE ledger_entries',
      'TRUNCATE transactions',
    ];

    const outcomes: Record<string, string[]> = {};
    for (const [role, pool] of [
      ['runtime', runtimePool()],
      ['owner', ownerPool()],
    ] as const) {
      const client: pg.PoolClient = await pool.connect();
      try {
        const user = await client.query<{ user: string }>('SELECT current_user AS user');
        outcomes[role] = [user.rows[0]?.user ?? ''];
        // Each statement runs in a transaction that is rolled back even if it succeeded.
        for (const statement of statements) {
          const error = await rejection(client, statement);
          outcomes[role].push(error.code ?? '');
        }
      } finally {
        client.release();
      }
    }

    // The runtime role lacks the privileges (LED-R17); the owner is stopped by the append-only
    // triggers, or for TRUNCATE transactions by the foreign keys that reference it.
    expect(outcomes).toEqual({
      runtime: ['scf_app', '42501', '42501', '42501', '42501', '42501', '42501'],
      owner: ['scf_owner', 'P0001', 'P0001', 'P0001', 'P0001', 'P0001', '0A000'],
    });
    expect(await snapshot(t1)).toEqual(before);
  });
});
