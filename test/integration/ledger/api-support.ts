import { runtimePool } from '../../support/db.js';

/**
 * The rows that involve some accounts: their ledger entries, the transactions of those entries and
 * the audit records that name them. Counted per account, not globally, because other test files
 * write to the shared test database (plan 000 section 9).
 */
export async function rowsTouching(
  accountIds: string[],
): Promise<{ transactions: string; entries: string; audits: string }> {
  const result = await runtimePool().query<{
    transactions: string;
    entries: string;
    audits: string;
  }>(
    `SELECT (SELECT count(DISTINCT transaction_id) FROM ledger_entries
              WHERE account_id = ANY ($1::uuid[]))::text AS transactions,
            (SELECT count(*) FROM ledger_entries WHERE account_id = ANY ($1::uuid[]))::text AS entries,
            (SELECT count(*) FROM audit_records WHERE account_ids && $1::uuid[])::text AS audits`,
    [accountIds],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('count returned no row');
  return row;
}

/** The stored row of an account: its row version (`xmin`) and its cached balance. */
export async function accountRow(id: string): Promise<{ xmin: string; balance: string | null }> {
  const result = await runtimePool().query<{ xmin: string; balance: string | null }>(
    'SELECT xmin::text AS xmin, balance FROM accounts WHERE id = $1',
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`No account ${id}`);
  return row;
}

/** The sum of an account's ledger entries, as an exact string. */
export async function entriesSum(id: string): Promise<string> {
  const result = await runtimePool().query<{ sum: string }>(
    'SELECT COALESCE(SUM(amount), 0)::text AS sum FROM ledger_entries WHERE account_id = $1',
    [id],
  );
  return result.rows[0]?.sum ?? 'NaN';
}
