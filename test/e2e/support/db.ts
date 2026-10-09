import pg from 'pg';
import { readCompose } from '../../support/deployment.js';
import { publishedPort } from './urls.js';

/**
 * The stack's database as its superuser, through the port PostgreSQL publishes on the host: what
 * the ACs read "in the database" (sessions, owners, counts) and the one write DEP-AC06 makes
 * directly, expiring the key rows.
 */
export function stackDatabaseUrl(): string {
  const compose = readCompose();
  const postgres = compose.service('postgres').environment;
  const user = postgres['POSTGRES_USER'] ?? 'postgres';
  const password = postgres['POSTGRES_PASSWORD'] ?? '';
  const database = new URL(compose.service('api-1').environment['DATABASE_URL'] ?? '').pathname;
  return `postgres://${user}:${encodeURIComponent(password)}@127.0.0.1:${publishedPort('postgres', '5432')}${database}`;
}

let pool: pg.Pool | undefined;

export function stackDb(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: stackDatabaseUrl(), max: 4 });
  return pool;
}

export async function closeStackDb(): Promise<void> {
  const current = pool;
  pool = undefined;
  await current?.end();
}

/** The global invariants of spec 000 read from the database: SYS-AC11 and SYS-AC12. */
export interface LedgerState {
  /** Per currency, customer cached balances plus the entries of system accounts (SYS-R13). */
  sums: { currency: string; sum: string }[];
  /** Customer accounts whose cached balance differs from the sum of their entries (SYS-R14). */
  drifted: string[];
  /** System accounts that hold a cached balance, which none may (ADR-0007). */
  systemWithBalance: number;
}

export async function ledgerState(): Promise<LedgerState> {
  const sums = await stackDb().query<{ currency: string; sum: string }>(
    `SELECT currency, SUM(amount)::text AS sum FROM (
       SELECT currency, balance AS amount FROM accounts WHERE kind = 'customer'
       UNION ALL
       SELECT a.currency, e.amount FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
        WHERE a.kind = 'system'
     ) totals GROUP BY currency ORDER BY currency`,
  );
  const drifted = await stackDb().query<{ id: string }>(
    `SELECT a.id FROM accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
      WHERE a.kind = 'customer'
      GROUP BY a.id, a.balance HAVING a.balance <> COALESCE(SUM(e.amount), 0)`,
  );
  const system = await stackDb().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM accounts WHERE kind = 'system' AND balance IS NOT NULL`,
  );
  return {
    sums: sums.rows,
    drifted: drifted.rows.map((row) => row.id),
    systemWithBalance: Number(system.rows[0]?.count ?? '0'),
  };
}

/** The ids of the transactions with an entry on any of `accountIds`. */
export async function transactionsOn(accountIds: readonly string[]): Promise<string[]> {
  const result = await stackDb().query<{ id: string }>(
    `SELECT DISTINCT transaction_id::text AS id FROM ledger_entries WHERE account_id = ANY($1::uuid[])`,
    [accountIds],
  );
  return result.rows.map((row) => row.id);
}
