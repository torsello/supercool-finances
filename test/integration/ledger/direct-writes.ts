import { randomUUID } from 'node:crypto';
import pg from 'pg';

export type Entry = [accountId: string, amount: string, currency: string];

/** Inserts a transaction row, then its entries one statement each, on an open transaction. */
export async function insertTransaction(
  client: pg.ClientBase,
  kind: string,
  currency: string,
  entries: Entry[],
  id: string = randomUUID(),
): Promise<string> {
  await client.query('INSERT INTO transactions (id, kind, currency) VALUES ($1, $2, $3)', [
    id,
    kind,
    currency,
  ]);
  for (const [accountId, amount, entryCurrency] of entries) {
    await client.query(
      `INSERT INTO ledger_entries (id, transaction_id, account_id, amount, currency)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), id, accountId, amount, entryCurrency],
    );
  }
  return id;
}

export interface Refusal {
  at: 'insert' | 'commit';
  error: pg.DatabaseError;
}

/**
 * Runs `body` in its own database transaction and commits it, expecting the database to refuse
 * either a statement of `body` (then rolled back) or the commit.
 */
export async function refusedWrite(
  client: pg.ClientBase,
  body: () => Promise<unknown>,
): Promise<Refusal> {
  await client.query('BEGIN');
  try {
    await body();
  } catch (error) {
    await client.query('ROLLBACK');
    if (error instanceof pg.DatabaseError) return { at: 'insert', error };
    throw error;
  }
  try {
    await client.query('COMMIT');
  } catch (error) {
    if (error instanceof pg.DatabaseError) return { at: 'commit', error };
    throw error;
  }
  throw new Error('Expected the database to refuse the write');
}

/** Rows of a transaction and its entries stored for these transaction ids. */
export async function storedRows(client: pg.ClientBase, transactionIds: string[]): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT (SELECT count(*) FROM transactions WHERE id = ANY($1::uuid[]))
          + (SELECT count(*) FROM ledger_entries WHERE transaction_id = ANY($1::uuid[])) AS count`,
    [transactionIds],
  );
  return Number.parseInt(result.rows[0]?.count ?? '-1', 10);
}
