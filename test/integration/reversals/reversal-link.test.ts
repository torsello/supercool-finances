import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  balanceOf,
  closePools,
  createCustomerAccount,
  rejection,
  runtimePool,
  settlementAccountId,
  TEST_OPERATOR_ID,
  writeDirectDeposit,
} from '../../support/db.js';

/**
 * Writes a complete reversal of a direct deposit as the service would: the reversal row linked to
 * the deposit, the flipped entries, the cached balance change and its audit record, so the shared
 * test database still reconciles (LED-R22).
 */
async function writeDirectReversal(
  app: pg.ClientBase,
  deposit: string,
  accountId: string,
  settlement: string,
  amount: string,
): Promise<string> {
  const id = randomUUID();
  await app.query('BEGIN');
  try {
    await app.query(`SELECT id FROM accounts WHERE id = $1 FOR UPDATE`, [accountId]);
    await app.query(
      `INSERT INTO transactions (id, kind, currency, reversed_transaction_id)
       VALUES ($1, 'reversal', 'EUR', $2)`,
      [id, deposit],
    );
    await app.query(
      `INSERT INTO ledger_entries (id, transaction_id, account_id, amount, currency)
       VALUES ($1, $3, $4, -$6::bigint, 'EUR'), ($2, $3, $5, $6::bigint, 'EUR')`,
      [randomUUID(), randomUUID(), id, accountId, settlement, amount],
    );
    await app.query('UPDATE accounts SET balance = balance - $2::bigint WHERE id = $1', [
      accountId,
      amount,
    ]);
    await app.query(
      `INSERT INTO audit_records (id, actor_id, actor_role, action, account_ids, transaction_id,
                                  reversed_transaction_id, reason, request_id)
       VALUES ($1, $2, 'operator', 'reversal', ARRAY[$3::uuid], $4, $5, 'Operator correction',
               'test-direct-reversal')`,
      [randomUUID(), TEST_OPERATOR_ID, accountId, id, deposit],
    );
    await app.query('COMMIT');
    return id;
  } catch (error) {
    await app.query('ROLLBACK');
    throw error;
  }
}

describe('reversal link', () => {
  let app: pg.PoolClient;

  beforeAll(async () => {
    app = await runtimePool().connect();
  });

  afterAll(async () => {
    app.release();
    await closePools();
  });

  it('REV-R05 refuses a reversal without a link, a deposit with one, and a second reversal of the same transaction', async () => {
    const a1 = await createCustomerAccount({ currency: 'EUR' });
    const s = await settlementAccountId('EUR');
    const { transactionId: d } = await writeDirectDeposit(a1, '1000');

    const unlinked = await rejection(
      app,
      `INSERT INTO transactions (id, kind, currency) VALUES ($1, 'reversal', 'EUR')`,
      [randomUUID()],
    );
    const linkedDeposit = await rejection(
      app,
      `INSERT INTO transactions (id, kind, currency, reversed_transaction_id)
       VALUES ($1, 'deposit', 'EUR', $2)`,
      [randomUUID(), d],
    );
    expect(unlinked).toMatchObject({ code: '23514', constraint: 'transactions_reversal_link' });
    expect(linkedDeposit).toMatchObject({
      code: '23514',
      constraint: 'transactions_reversal_link',
    });

    const first = await writeDirectReversal(app, d, a1.id, s, '1000');
    expect(await balanceOf(a1.id)).toBe('0');

    const second = await rejection(
      app,
      `INSERT INTO transactions (id, kind, currency, reversed_transaction_id)
       VALUES ($1, 'reversal', 'EUR', $2)`,
      [randomUUID(), d],
    );
    expect(second).toMatchObject({
      code: '23505',
      constraint: 'transactions_reversed_transaction_id_key',
    });

    const reversals = await app.query<{ id: string }>(
      'SELECT id FROM transactions WHERE reversed_transaction_id = $1',
      [d],
    );
    expect(reversals.rows).toEqual([{ id: first }]);
    expect(await balanceOf(a1.id)).toBe('0');
  });
});
