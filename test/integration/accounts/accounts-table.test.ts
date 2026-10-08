import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rejection, rollingBack } from '../../support/db.js';
import { requireEnv } from '../../support/env.js';

const INSERT = `INSERT INTO accounts (id, kind, owner_id, currency, status, balance)
                VALUES ($1, 'customer', $2, $3, $4, $5)`;

describe('accounts table', () => {
  let runtime: pg.Client;

  beforeAll(async () => {
    runtime = new pg.Client({ connectionString: requireEnv('TEST_DATABASE_URL') });
    await runtime.connect();
  });

  afterAll(async () => {
    await runtime.end();
  });

  it('ACC-R01 stores a customer account with its owner, currency, status and balance, created_at equal to updated_at', async () => {
    await rollingBack(runtime, async () => {
      const id = randomUUID();
      const owner = randomUUID();
      await runtime.query(INSERT, [id, owner, 'JPY', 'active', '0']);
      const row = await runtime.query<{ equal: boolean; owner_id: string; balance: string }>(
        'SELECT created_at = updated_at AS equal, owner_id, balance FROM accounts WHERE id = $1',
        [id],
      );
      expect(row.rows[0]).toEqual({ equal: true, owner_id: owner, balance: '0' });
    });
  });

  it('ACC-R01 refuses a customer account without an owner, a status or a balance', async () => {
    for (const [owner, status, balance] of [
      [null, 'active', '0'],
      [randomUUID(), null, '0'],
      [randomUUID(), 'active', null],
    ]) {
      const error = await rejection(runtime, INSERT, [randomUUID(), owner, 'EUR', status, balance]);
      expect(error).toMatchObject({ code: '23514', constraint: 'accounts_kind_columns' });
    }
  });

  it('SYS-R08 refuses a currency outside the currency table', async () => {
    for (const currency of ['GBP', 'eur', 'US']) {
      const error = await rejection(runtime, INSERT, [
        randomUUID(),
        randomUUID(),
        currency,
        'active',
        '0',
      ]);
      expect(error.code).toBe('23514');
    }
  });

  it('ACC-R01 refuses a status outside active, frozen and closed', async () => {
    const error = await rejection(runtime, INSERT, [
      randomUUID(),
      randomUUID(),
      'EUR',
      'suspended',
      '0',
    ]);
    expect(error).toMatchObject({ code: '23514', constraint: 'accounts_status_check' });
  });

  it('LED-R12 refuses a negative balance, on insert and on update', async () => {
    const insert = await rejection(runtime, INSERT, [
      randomUUID(),
      randomUUID(),
      'EUR',
      'active',
      '-1',
    ]);
    expect(insert).toMatchObject({ code: '23514', constraint: 'accounts_balance_check' });

    await rollingBack(runtime, async () => {
      const id = randomUUID();
      await runtime.query(INSERT, [id, randomUUID(), 'EUR', 'active', '0']);
      await expect(
        runtime.query('UPDATE accounts SET balance = -1 WHERE id = $1', [id]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'accounts_balance_check' });
    });
  });

  it('ACC-R16 refuses a closed account whose balance is not 0', async () => {
    const error = await rejection(runtime, INSERT, [
      randomUUID(),
      randomUUID(),
      'EUR',
      'closed',
      '5',
    ]);
    expect(error).toMatchObject({ code: '23514', constraint: 'accounts_closed_is_empty' });

    await rollingBack(runtime, async () => {
      await runtime.query(INSERT, [randomUUID(), randomUUID(), 'EUR', 'closed', '0']);
    });
  });

  it('ACC-R01 lets scf_app update only status, balance and updated_at', async () => {
    await rollingBack(runtime, async () => {
      const id = randomUUID();
      await runtime.query(INSERT, [id, randomUUID(), 'EUR', 'active', '0']);
      await runtime.query(
        `UPDATE accounts SET status = 'frozen', balance = 10, updated_at = clock_timestamp()
         WHERE id = $1`,
        [id],
      );
    });

    for (const assignment of [
      `owner_id = '${randomUUID()}'`,
      `currency = 'USD'`,
      `kind = 'system'`,
      `code = 'x'`,
      `created_at = now()`,
      `id = '${randomUUID()}'`,
    ]) {
      const error = await rejection(runtime, `UPDATE accounts SET ${assignment}`);
      expect(error.code).toBe('42501');
    }
    for (const statement of ['DELETE FROM accounts', 'TRUNCATE accounts']) {
      const error = await rejection(runtime, statement);
      expect(error.code).toBe('42501');
    }
  });
});
