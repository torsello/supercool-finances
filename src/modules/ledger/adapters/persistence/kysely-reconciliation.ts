import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../../platform/db/schema.js';
import { CURRENCIES, type CurrencyCode } from '../../domain/currency.js';
import type { CurrencyTotal, Discrepancy, ReconciliationQuery } from '../../application/ports.js';

/**
 * The reconciliation statements of plan 002 section 5, on the executor it is given, so a test can
 * run them inside its own transaction (LED-AC14). Every sum is `numeric`, returned as text, so it
 * never overflows (LED-R15).
 */
export class KyselyReconciliation implements ReconciliationQuery {
  constructor(private readonly db: Kysely<Database>) {}

  async discrepancies(): Promise<Discrepancy[]> {
    const result = await sql<{
      id: string;
      currency: CurrencyCode;
      cached: string;
      entries: string;
      difference: string;
    }>`
      SELECT a.id, a.currency, a.balance::text AS cached, COALESCE(s.total, 0)::text AS entries,
             (a.balance - COALESCE(s.total, 0))::text AS difference
      FROM accounts a
      LEFT JOIN (SELECT account_id, SUM(amount) AS total FROM ledger_entries GROUP BY account_id) s
        ON s.account_id = a.id
      WHERE a.kind = 'customer' AND a.balance <> COALESCE(s.total, 0)
      ORDER BY a.id`.execute(this.db);
    return result.rows.map((row) => ({
      accountId: row.id,
      currency: row.currency,
      cachedBalance: row.cached,
      entriesSum: row.entries,
      difference: row.difference,
    }));
  }

  async totals(): Promise<CurrencyTotal[]> {
    // One row per currency of table 1.3, in table order, from the domain's currency table.
    const currencies = sql.join(
      CURRENCIES.map(({ code }, position) => sql`(${code}::char(3), ${position}::int)`),
    );
    const result = await sql<{ currency: CurrencyCode; total: string }>`
      SELECT c.currency,
        (COALESCE((SELECT SUM(balance) FROM accounts
                   WHERE kind = 'customer' AND currency = c.currency), 0)
         + COALESCE((SELECT SUM(e.amount) FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
                     WHERE a.kind = 'system' AND a.currency = c.currency), 0))::text AS total
      FROM (VALUES ${currencies}) AS c (currency, position)
      ORDER BY c.position`.execute(this.db);
    return result.rows.map((row) => ({ currency: row.currency, sum: row.total }));
  }
}
