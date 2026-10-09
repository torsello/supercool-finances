import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPool } from '../../src/platform/db/database.js';
import type { CurrencyCode } from '../../src/platform/db/schema.js';
import { requireEnv } from './env.js';
import { migrate } from './migrations.js';

/** Pool warnings from the helpers' pools are shown, not swallowed. */
const testLogger = {
  warn(fields: Record<string, unknown>, message: string): void {
    console.warn(message, fields);
  },
};

let runtime: pg.Pool | undefined;
let owner: pg.Pool | undefined;

/**
 * The runtime role `scf_app` on the shared test database: the role of "written directly to the
 * database" in the ACs (LED-R17). Created on first use; a test file that uses it calls
 * `closePools()` in `afterAll`.
 */
export function runtimePool(): pg.Pool {
  runtime ??= createPool({
    connectionString: requireEnv('TEST_DATABASE_URL'),
    max: 4,
    logger: testLogger,
  });
  return runtime;
}

/** The owner role `scf_owner` on the shared test database, for catalogue reads and owner checks. */
export function ownerPool(): pg.Pool {
  owner ??= createPool({
    connectionString: requireEnv('TEST_MIGRATION_DATABASE_URL'),
    max: 2,
    logger: testLogger,
  });
  return owner;
}

export async function closePools(): Promise<void> {
  const pools = [runtime, owner];
  runtime = undefined;
  owner = undefined;
  await Promise.all(pools.map(async (pool) => await pool?.end()));
}

export interface TestAccount {
  id: string;
  ownerId: string;
  currency: CurrencyCode;
}

/**
 * Inserts an active customer account with balance 0 as the runtime role, as the service would; on
 * the shared test database unless another pool, such as a scratch database's, is given.
 */
export async function createCustomerAccount(options: {
  currency: CurrencyCode;
  ownerId?: string;
  pool?: pg.Pool;
}): Promise<TestAccount> {
  const account = {
    id: randomUUID(),
    ownerId: options.ownerId ?? randomUUID(),
    currency: options.currency,
  };
  await (options.pool ?? runtimePool()).query(
    `INSERT INTO accounts (id, kind, owner_id, currency, status, balance)
     VALUES ($1, 'customer', $2, $3, 'active', 0)`,
    [account.id, account.ownerId, account.currency],
  );
  return account;
}

/** The id of the settlement account of a currency (LED-R08). */
export async function settlementAccountId(currency: CurrencyCode): Promise<string> {
  const result = await runtimePool().query<{ id: string }>(
    `SELECT id FROM accounts WHERE kind = 'system' AND code = $1`,
    [`external-settlement:${currency}`],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error(`No settlement account for ${currency}`);
  return id;
}

/** The cached balance of a customer account, as an exact string. */
export async function balanceOf(accountId: string): Promise<string> {
  const result = await runtimePool().query<{ balance: string | null }>(
    'SELECT balance FROM accounts WHERE id = $1',
    [accountId],
  );
  const balance = result.rows[0]?.balance;
  if (balance === undefined || balance === null)
    throw new Error(`No customer account ${accountId}`);
  return balance;
}

/** The operator every direct deposit is attributed to in its audit record. */
export const TEST_OPERATOR_ID = '00000000-0000-4000-8000-0000000000ff';

/**
 * Writes a complete deposit as the service would (the preamble of section 3 of spec 002): as the
 * runtime role, in one database transaction, it locks the account, inserts the transaction, +A on
 * the account and −A on the settlement account of its currency, raises the cached balance by A and
 * writes an audit record of action `deposit` by a test operator, so the shared test database still
 * reconciles (LED-R22). `amount` is a string of decimal digits, in minor units. The deposit goes
 * to the shared test database unless another pool is given.
 */
export async function writeDirectDeposit(
  account: { id: string },
  amount: string,
  pool: pg.Pool = runtimePool(),
): Promise<{ transactionId: string }> {
  if (!/^[1-9][0-9]*$/.test(amount)) throw new Error(`Not a positive amount: ${amount}`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query<{ currency: CurrencyCode }>(
      `SELECT currency FROM accounts WHERE id = $1 AND kind = 'customer' FOR UPDATE`,
      [account.id],
    );
    const currency = locked.rows[0]?.currency;
    if (currency === undefined) throw new Error(`No customer account ${account.id}`);
    const settlement = await client.query<{ id: string }>(
      `SELECT id FROM accounts WHERE kind = 'system' AND code = $1`,
      [`external-settlement:${currency}`],
    );
    const transactionId = randomUUID();
    await client.query(`INSERT INTO transactions (id, kind, currency) VALUES ($1, 'deposit', $2)`, [
      transactionId,
      currency,
    ]);
    await client.query(
      `INSERT INTO ledger_entries (id, transaction_id, account_id, amount, currency)
       VALUES ($1, $3, $4, $6::bigint, $7), ($2, $3, $5, -$6::bigint, $7)`,
      [
        randomUUID(),
        randomUUID(),
        transactionId,
        account.id,
        settlement.rows[0]?.id,
        amount,
        currency,
      ],
    );
    await client.query(
      `UPDATE accounts SET balance = balance + $2::bigint, updated_at = clock_timestamp()
       WHERE id = $1 AND kind = 'customer'`,
      [account.id, amount],
    );
    await client.query(
      `INSERT INTO audit_records (id, actor_id, actor_role, action, account_ids, transaction_id, request_id)
       VALUES ($1, $2, 'operator', 'deposit', ARRAY[$3::uuid], $4, 'test-direct-deposit')`,
      [randomUUID(), TEST_OPERATOR_ID, account.id, transactionId],
    );
    await client.query('COMMIT');
    return { transactionId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Replaces the database name of a connection URL, keeping its role and host. */
export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

export interface ScratchDatabase {
  name: string;
  /** The runtime role `scf_app` on the scratch database. */
  runtimeUrl: string;
  /** The owner role `scf_owner` on the scratch database. */
  ownerUrl: string;
}

/**
 * Creates an empty database as the owner role, migrates it to the latest migration unless
 * `migrated` is false, runs `body` and drops the database afterwards, also when `body` fails (plan
 * 000 section 9, ADR-0020). The body must close every connection it opens before it returns: the
 * owner role cannot end the runtime role's sessions, so a database with an open session cannot be
 * dropped.
 */
export async function withScratchDatabase<T>(
  body: (scratch: ScratchDatabase) => T | Promise<T>,
  options: { migrated?: boolean } = {},
): Promise<T> {
  const ownerUrl = requireEnv('TEST_MIGRATION_DATABASE_URL');
  const runtimeUrl = requireEnv('TEST_DATABASE_URL');
  const name = `scf_scratch_${randomBytes(6).toString('hex')}`;

  const admin = new pg.Client({ connectionString: ownerUrl });
  await admin.connect();
  try {
    // The name is generated above from hex digits only, so it is a safe identifier.
    await admin.query(`CREATE DATABASE ${name}`);
    try {
      const scratch = {
        name,
        runtimeUrl: withDatabase(runtimeUrl, name),
        ownerUrl: withDatabase(ownerUrl, name),
      };
      if (options.migrated ?? true) await migrate(scratch.ownerUrl, 'up');
      return await body(scratch);
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    }
  } finally {
    await admin.end();
  }
}

/** Runs `body` inside a database transaction that is always rolled back. */
export async function rollingBack<T>(client: pg.ClientBase, body: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    return await body();
  } finally {
    await client.query('ROLLBACK');
  }
}

/** Runs one statement in its own rolled-back transaction and returns the error it raised. */
export async function rejection(
  client: pg.ClientBase,
  text: string,
  values: unknown[] = [],
): Promise<pg.DatabaseError> {
  return await rollingBack(client, async () => {
    try {
      await client.query(text, values);
    } catch (error) {
      if (error instanceof pg.DatabaseError) return error;
      throw error;
    }
    throw new Error(`Expected the database to reject: ${text}`);
  });
}
