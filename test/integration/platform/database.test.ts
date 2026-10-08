import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Selectable } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, createPool } from '../../../src/platform/db/database.js';
import type {
  AccountsTable,
  AuditRecordsTable,
  Database,
  LedgerEntriesTable,
  TransactionsTable,
} from '../../../src/platform/db/schema.js';
import { clockTimestamp, timestampText } from '../../../src/platform/db/timestamp.js';
import { requireEnv } from '../../support/env.js';

const MAX_BIGINT = '9223372036854775807';
const RFC3339_MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

class Rollback extends Error {}

interface LogLine {
  fields: Record<string, unknown>;
  message: string;
}

function capturingLogger(lines: LogLine[]) {
  return {
    warn(fields: Record<string, unknown>, message: string) {
      lines.push({ fields, message });
    },
  };
}

type Lacks<T, K extends string> = K extends keyof T ? false : true;

/** Rows read with selectAll() carry no timestamp column at all. */
const timestampsAreNeverSelected: [
  Lacks<Selectable<LedgerEntriesTable>, 'created_at'>,
  Lacks<Selectable<TransactionsTable>, 'created_at'>,
  Lacks<Selectable<AuditRecordsTable>, 'created_at'>,
  Lacks<Selectable<AccountsTable>, 'created_at' | 'updated_at'>,
] = [true, true, true, true];

/**
 * Compile-time checks of the Database types: the append-only tables have no updatable column and
 * timestamps are never selected as Date. Never called; `npm run typecheck` fails if the types
 * allow what the expect-error lines try.
 */
export function typeChecks(db: Kysely<Database>): unknown[] {
  return [
    // @ts-expect-error transactions are append-only (LED-R16)
    db.updateTable('transactions').set({ kind: 'withdrawal' }),
    // @ts-expect-error ledger entries are append-only (LED-R16)
    db.updateTable('ledger_entries').set({ amount: '2000' }),
    // @ts-expect-error audit records are append-only (SYS-R23)
    db.updateTable('audit_records').set({ reason: 'changed' }),
    // @ts-expect-error updated_at is only ever the database clock, never a Date
    db.updateTable('accounts').set({ updated_at: new Date() }),
    db.updateTable('accounts').set({ status: 'frozen', updated_at: clockTimestamp() }),
    timestampsAreNeverSelected,
    async (): Promise<never> => {
      // A timestamp named in select() has type never: returning it as never compiles only then.
      const row = await db
        .selectFrom('ledger_entries')
        .select('created_at')
        .executeTakeFirstOrThrow();
      return row.created_at;
    },
  ];
}

describe('Kysely instance', () => {
  const lines: LogLine[] = [];
  let pool: pg.Pool;
  let db: Kysely<Database>;

  beforeAll(() => {
    pool = createPool({
      connectionString: requireEnv('TEST_DATABASE_URL'),
      max: 2,
      logger: capturingLogger(lines),
    });
    db = createDatabase(pool);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('LED-R27 returns int8 and numeric values as exact decimal strings', async () => {
    const result = await sql<{ int8: unknown; negative: unknown; numeric: unknown }>`
      SELECT ${MAX_BIGINT}::int8 AS int8,
             (-${MAX_BIGINT}::int8 - 1) AS negative,
             (${MAX_BIGINT}::numeric * 10 + 7) AS numeric`.execute(db);

    expect(result.rows[0]).toEqual({
      int8: MAX_BIGINT,
      negative: '-9223372036854775808',
      numeric: '92233720368547758077',
    });
  });

  it('LED-R27 returns int8[] and numeric[] values as arrays of exact decimal strings', async () => {
    const result = await sql<{ int8s: unknown; numerics: unknown }>`
      SELECT ARRAY[${MAX_BIGINT}::int8, -${MAX_BIGINT}::int8 - 1, NULL] AS int8s,
             ARRAY[${MAX_BIGINT}::numeric * 2, -0.5, NULL] AS numerics`.execute(db);

    expect(result.rows[0]).toEqual({
      int8s: [MAX_BIGINT, '-9223372036854775808', null],
      numerics: ['18446744073709551614', '-0.5', null],
    });
  });

  it('LED-R27 reads a bigint balance column and a numeric sum as exact strings', async () => {
    const id = randomUUID();
    const read = db.transaction().execute(async (trx) => {
      await trx
        .insertInto('accounts')
        .values({
          id,
          kind: 'customer',
          owner_id: randomUUID(),
          currency: 'EUR',
          status: 'active',
          balance: MAX_BIGINT,
        })
        .execute();
      const row = await trx
        .selectFrom('accounts')
        .select(['balance', sql<string>`balance::numeric + balance::numeric`.as('doubled')])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ balance: MAX_BIGINT, doubled: '18446744073709551614' });
      throw new Rollback();
    });

    await expect(read).rejects.toBeInstanceOf(Rollback);
  });

  it('LED-R18 reads timestamps as RFC 3339 strings with microseconds, exact to the database value', async () => {
    const id = randomUUID();
    const read = db.transaction().execute(async (trx) => {
      await trx
        .insertInto('accounts')
        .values({
          id,
          kind: 'customer',
          owner_id: randomUUID(),
          currency: 'EUR',
          status: 'active',
          balance: '0',
        })
        .execute();
      const row = await trx
        .selectFrom('accounts')
        .select([
          timestampText('created_at').as('created_at'),
          sql<string>`created_at::text`.as('raw'),
        ])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      const exact = await sql<{ same: boolean }>`
        SELECT ${row.created_at}::timestamptz = created_at AS same FROM accounts WHERE id = ${id}`.execute(
        trx,
      );

      expect(row.created_at).toMatch(RFC3339_MICROS);
      expect(exact.rows[0]?.same).toBe(true);
      throw new Rollback();
    });

    await expect(read).rejects.toBeInstanceOf(Rollback);
  });

  it('survives a pooled connection lost while idle, logs it at warn without the URL, and serves the next query', async () => {
    const url = requireEnv('TEST_DATABASE_URL');
    const before = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const pid = before.rows[0]?.pid;
    expect(pool.idleCount).toBe(1);

    // The runtime role may end its own sessions; the pooled client is idle in the pool meanwhile.
    const killer = new pg.Client({ connectionString: url });
    await killer.connect();
    try {
      await killer.query('SELECT pg_terminate_backend($1)', [pid]);
    } finally {
      await killer.end();
    }
    const deadline = Date.now() + 5000;
    while (lines.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(lines).toEqual([
      { fields: { sqlstate: '57P01' }, message: 'idle database connection lost' },
    ]);
    const logged = JSON.stringify(lines);
    const { password, host, username } = new URL(url);
    for (const secret of [url, password, host, username]) expect(logged).not.toContain(secret);

    const after = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    expect(after.rows[0]?.pid).not.toBe(pid);
  });
});

describe('pool clients checked out outside the transaction runner', () => {
  it('SYS-R11 survives the loss of a checked-out connection and logs it at warn with the SQLSTATE only', async () => {
    const url = requireEnv('TEST_DATABASE_URL');
    const lines: LogLine[] = [];
    const pool = createPool({ connectionString: url, max: 1, logger: capturingLogger(lines) });
    try {
      const client = await pool.connect();
      const before = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const pid = before.rows[0]?.pid;

      // The runtime role may end its own sessions; the client stays checked out meanwhile.
      const killer = new pg.Client({ connectionString: url });
      await killer.connect();
      try {
        await killer.query('SELECT pg_terminate_backend($1)', [pid]);
      } finally {
        await killer.end();
      }
      const deadline = Date.now() + 5000;
      while (lines.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      client.release();

      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0]).toEqual({
        fields: { sqlstate: '57P01' },
        message: 'database connection lost',
      });
      expect(lines.every((line) => Object.keys(line.fields).join() === 'sqlstate')).toBe(true);
      const logged = JSON.stringify(lines);
      const { password, host, username } = new URL(url);
      for (const secret of [url, password, host, username]) expect(logged).not.toContain(secret);

      const after = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      expect(after.rows[0]?.pid).not.toBe(pid);
    } finally {
      await pool.end();
    }
  });
});
