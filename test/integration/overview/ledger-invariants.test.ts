import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { balanceOf, closePools, runtimePool, settlementAccountId } from '../../support/db.js';
import {
  createAccount,
  deposit,
  reverse,
  transfer,
  withdraw,
  type AccountJson,
  type MovementJson,
} from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';
import { insertTransaction, refusedWrite, storedRows } from '../ledger/direct-writes.js';

describe('ledger invariants (SYS-R10, SYS-R13, SYS-R14)', () => {
  let built: BuiltApp;
  let client: pg.PoolClient;
  const c1 = tokenFor(randomUUID(), 'customer');
  const c2 = tokenFor(randomUUID(), 'customer');
  const o1 = tokenFor(randomUUID(), 'operator');
  let a1: AccountJson;
  let b1: AccountJson;
  let j1: AccountJson;
  /** The five transactions of SYS-AC08. */
  const five: string[] = [];

  function created(response: { statusCode: number; body: string }): string {
    expect(response.statusCode, response.body).toBe(201);
    return (JSON.parse(response.body) as MovementJson).id;
  }

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
    client = await runtimePool().connect();

    // Given: A1 with "10000" EUR, B1 with "0" EUR, and J1 owned by C1 with "0" JPY.
    a1 = await createAccount(built.app, c1);
    b1 = await createAccount(built.app, c2);
    j1 = await createAccount(built.app, c1, 'JPY');
    created(await deposit(built.app, o1, a1.id, '10000'));

    five.push(
      created(await deposit(built.app, o1, a1.id, '5000')),
      created(await deposit(built.app, o1, j1.id, '1500', { currency: 'JPY' })),
      created(await withdraw(built.app, c1, a1.id, '2000')),
    );
    const transferId = created(await transfer(built.app, c1, a1.id, b1.id, '3000'));
    five.push(transferId, created(await reverse(built.app, o1, transferId)));
  });

  afterAll(async () => {
    client.release();
    await built.app.close();
    await closePools();
  });

  it('SYS-AC08 every transaction is balanced, and the database refuses one that is not', async () => {
    expect(five).toHaveLength(5);
    for (const id of five) {
      const entries = await client.query<{ currency: string; count: string; sum: string }>(
        `SELECT currency, count(*) AS count, sum(amount) AS sum
           FROM ledger_entries WHERE transaction_id = $1 GROUP BY currency`,
        [id],
      );
      const total = entries.rows.reduce((count, row) => count + Number(row.count), 0);
      expect(total, id).toBeGreaterThanOrEqual(2);
      for (const row of entries.rows) expect(row.sum, `${id} ${row.currency}`).toBe('0');
    }

    const s = await settlementAccountId('EUR');
    const before = await balanceOf(a1.id);
    const id = randomUUID();
    const refusal = await refusedWrite(client, async () => {
      await insertTransaction(
        client,
        'deposit',
        'EUR',
        [
          [a1.id, '100', 'EUR'],
          [s, '-99', 'EUR'],
        ],
        id,
      );
    });
    expect(refusal.at).toBe('commit');
    expect(await storedRows(client, [id])).toBe(0);
    expect(await balanceOf(a1.id)).toBe(before);
  });

  /**
   * The balances of all accounts summed per currency, in one statement so it reads one snapshot:
   * cached balances for customer accounts, the sum of entries for system accounts.
   */
  async function sumsPerCurrency(): Promise<Record<string, string>> {
    const result = await client.query<{ currency: string; total: string }>(
      `SELECT currency, sum(amount)::text AS total FROM (
         SELECT currency, balance AS amount FROM accounts WHERE kind = 'customer'
         UNION ALL
         SELECT e.currency, e.amount FROM ledger_entries e
           JOIN accounts a ON a.id = e.account_id WHERE a.kind = 'system'
       ) AS balances GROUP BY currency`,
    );
    return Object.fromEntries(result.rows.map((row) => [row.currency, row.total]));
  }

  it('SYS-AC11 balances sum to zero in every currency', async () => {
    const sums = await sumsPerCurrency();
    expect(sums['EUR']).toBe('0');
    expect(sums['JPY']).toBe('0');
  });

  it('SYS-AC12 cached balances match the ledger, also after concurrent withdrawals', async () => {
    created(await withdraw(built.app, c1, a1.id, '12000'));
    expect(await balanceOf(a1.id)).toBe('1000');

    const answers = await Promise.all(
      Array.from({ length: 10 }, async () => await withdraw(built.app, c1, a1.id, '300')),
    );
    const statuses = answers.map((answer) => answer.statusCode).sort();
    expect(statuses.filter((status) => status === 201)).toHaveLength(3);
    expect(await balanceOf(a1.id)).toBe('100');

    // One statement: every customer account whose cached balance differs from its entries.
    const drift = await client.query(
      `SELECT a.id, a.balance, coalesce(sum(e.amount), 0) AS entries
         FROM accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
        WHERE a.kind = 'customer'
        GROUP BY a.id, a.balance
       HAVING a.balance IS DISTINCT FROM coalesce(sum(e.amount), 0)`,
    );
    expect(drift.rows).toEqual([]);
    for (const account of [a1, b1, j1]) {
      const own = await client.query<{ balance: string; entries: string }>(
        `SELECT a.balance, coalesce(sum(e.amount), 0)::text AS entries
           FROM accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
          WHERE a.id = $1 GROUP BY a.balance`,
        [account.id],
      );
      expect(own.rows[0]?.balance).toBe(own.rows[0]?.entries);
    }

    const cached = await client.query(
      `SELECT id FROM accounts WHERE kind = 'system' AND balance IS NOT NULL`,
    );
    expect(cached.rows).toEqual([]);
  });
});
