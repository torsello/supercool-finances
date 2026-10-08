import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { withScratchDatabase } from '../../support/db.js';

type Entry = [account: string, amount: string, currency: string];

async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

async function customer(client: pg.Client, currency: string): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO accounts (id, kind, owner_id, currency, status, balance)
     VALUES ($1, 'customer', $2, $3, 'active', 0)`,
    [id, randomUUID(), currency],
  );
  return id;
}

/** Inserts a transaction row and its entries one statement at a time, without committing. */
async function insertTransaction(
  client: pg.Client,
  currency: string,
  entries: Entry[],
): Promise<string> {
  const id = randomUUID();
  await client.query(`INSERT INTO transactions (id, kind, currency) VALUES ($1, 'transfer', $2)`, [
    id,
    currency,
  ]);
  for (const [account, amount, entryCurrency] of entries) {
    await client.query(
      `INSERT INTO ledger_entries (id, transaction_id, account_id, amount, currency)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), id, account, amount, entryCurrency],
    );
  }
  return id;
}

async function stored(client: pg.Client, transactionId: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT (SELECT count(*) FROM transactions WHERE id = $1)
          + (SELECT count(*) FROM ledger_entries WHERE transaction_id = $1) AS count`,
    [transactionId],
  );
  return Number.parseInt(result.rows[0]?.count ?? '-1', 10);
}

/** Writes a transaction in its own database transaction and returns the error of its insert or commit. */
async function refused(
  client: pg.Client,
  currency: string,
  entries: Entry[],
): Promise<{ at: 'insert' | 'commit'; error: pg.DatabaseError; id: string }> {
  await client.query('BEGIN');
  let id = '';
  try {
    id = await insertTransaction(client, currency, entries);
  } catch (error) {
    await client.query('ROLLBACK');
    if (!(error instanceof pg.DatabaseError)) throw error;
    return { at: 'insert', error, id };
  }
  try {
    await client.query('COMMIT');
  } catch (error) {
    if (!(error instanceof pg.DatabaseError)) throw error;
    return { at: 'commit', error, id };
  }
  throw new Error('Expected the database to refuse the transaction');
}

// The cached balances of a scratch database are left untouched: before the settlement accounts
// and writeDirectDeposit exist, transfer-shaped rows between two customer accounts cannot match
// them, and the scratch database is dropped afterwards (LED-R22 applies to the shared one).
describe('ledger schema', () => {
  it('LED-R04 LED-R05 LED-R06 commits a balanced transfer-shaped transaction inserted entry by entry', async () => {
    await withScratchDatabase(async ({ runtimeUrl }) => {
      const app = await connect(runtimeUrl);
      try {
        const a = await customer(app, 'EUR');
        const b = await customer(app, 'EUR');
        await app.query('BEGIN');
        const id = await insertTransaction(app, 'EUR', [
          [a, '-100', 'EUR'],
          [b, '100', 'EUR'],
        ]);
        await app.query('COMMIT');
        expect(await stored(app, id)).toBe(3);
      } finally {
        await app.end();
      }
    });
  });

  it('LED-R03 LED-R04 LED-R05 LED-R07 refuses zero amounts, single entries, unbalanced pairs and foreign currencies', async () => {
    await withScratchDatabase(async ({ runtimeUrl }) => {
      const app = await connect(runtimeUrl);
      try {
        const a = await customer(app, 'EUR');
        const b = await customer(app, 'EUR');
        const u = await customer(app, 'USD');
        const v = await customer(app, 'USD');

        const zero = await refused(app, 'EUR', [
          [a, '0', 'EUR'],
          [b, '0', 'EUR'],
        ]);
        expect(zero).toMatchObject({
          at: 'insert',
          error: { code: '23514', constraint: 'ledger_entries_amount_not_zero' },
        });

        const single = await refused(app, 'EUR', [[a, '100', 'EUR']]);
        expect(single).toMatchObject({
          at: 'commit',
          error: { code: '23514', constraint: 'ledger_transaction_min_entries' },
        });

        const unbalanced = await refused(app, 'EUR', [
          [a, '-100', 'EUR'],
          [b, '99', 'EUR'],
        ]);
        expect(unbalanced).toMatchObject({
          at: 'commit',
          error: { code: '23514', constraint: 'ledger_transaction_balanced' },
        });

        // An entry in USD on a EUR account, in a USD transaction: the account's currency differs.
        const accountCurrency = await refused(app, 'USD', [
          [a, '-100', 'USD'],
          [u, '100', 'USD'],
        ]);
        expect(accountCurrency).toMatchObject({
          at: 'insert',
          error: { code: '23503', constraint: 'ledger_entries_account_id_currency_fkey' },
        });

        // USD entries on USD accounts in a EUR transaction: the transaction's currency differs.
        const transactionCurrency = await refused(app, 'EUR', [
          [u, '-100', 'USD'],
          [v, '100', 'USD'],
        ]);
        expect(transactionCurrency).toMatchObject({
          at: 'insert',
          error: { code: '23503', constraint: 'ledger_entries_transaction_id_currency_fkey' },
        });

        for (const attempt of [zero, single, unbalanced, accountCurrency, transactionCurrency]) {
          if (attempt.id !== '') expect(await stored(app, attempt.id)).toBe(0);
        }
      } finally {
        await app.end();
      }
    });
  });

  it('LED-R16 LED-R17 refuses UPDATE, DELETE and TRUNCATE on transactions and ledger entries by both roles', async () => {
    await withScratchDatabase(async ({ runtimeUrl, ownerUrl }) => {
      const app = await connect(runtimeUrl);
      const owner = await connect(ownerUrl);
      try {
        const a = await customer(app, 'EUR');
        const b = await customer(app, 'EUR');
        await app.query('BEGIN');
        const id = await insertTransaction(app, 'EUR', [
          [a, '-100', 'EUR'],
          [b, '100', 'EUR'],
        ]);
        await app.query('COMMIT');

        const statements = [
          `UPDATE ledger_entries SET amount = 2000 WHERE transaction_id = '${id}'`,
          `DELETE FROM ledger_entries WHERE transaction_id = '${id}'`,
          `UPDATE transactions SET kind = 'withdrawal' WHERE id = '${id}'`,
          `DELETE FROM transactions WHERE id = '${id}'`,
          'TRUNCATE ledger_entries',
          // With every referencing table listed, no foreign key stops it first: the trigger does.
          'TRUNCATE ledger_entries, transactions, audit_records',
        ];
        for (const [client, code] of [
          [app, '42501'],
          [owner, 'P0001'],
        ] as const) {
          for (const statement of statements) {
            await expect(client.query(statement)).rejects.toMatchObject({ code });
          }
        }
        expect(await stored(app, id)).toBe(3);
      } finally {
        await app.end();
        await owner.end();
      }
    });
  });
});
