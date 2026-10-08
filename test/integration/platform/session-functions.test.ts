import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withDatabase } from '../../support/db.js';
import { requireEnv } from '../../support/env.js';

const FUNCTIONS = ['app.set_lock_timeout(integer)', 'app.set_statement_timeout(integer)'];

async function inTransaction<T>(client: pg.Client, body: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    return await body();
  } finally {
    await client.query('ROLLBACK');
  }
}

async function show(client: pg.Client, setting: string): Promise<string | undefined> {
  const result = await client.query<Record<string, string>>(`SHOW ${setting}`);
  return result.rows[0]?.[setting];
}

describe('transaction-local session functions', () => {
  let runtime: pg.Client;
  let owner: pg.Client;

  beforeAll(async () => {
    runtime = new pg.Client({ connectionString: requireEnv('TEST_DATABASE_URL') });
    owner = new pg.Client({ connectionString: requireEnv('TEST_MIGRATION_DATABASE_URL') });
    await runtime.connect();
    await owner.connect();
  });

  afterAll(async () => {
    await runtime.end();
    await owner.end();
  });

  it('SEC-R31 app.set_lock_timeout sets lock_timeout only until the transaction ends', async () => {
    const before = await show(runtime, 'lock_timeout');

    await runtime.query('BEGIN');
    await runtime.query('SELECT app.set_lock_timeout(300)');
    const inside = await show(runtime, 'lock_timeout');
    await runtime.query('COMMIT');

    expect(inside).toBe('300ms');
    expect(await show(runtime, 'lock_timeout')).toBe(before);
  });

  it('SEC-R31 app.set_lock_timeout accepts 1 and 60000 and refuses 0, 60001 and null', async () => {
    for (const ms of [1, 60000]) {
      await inTransaction(runtime, async () => {
        await runtime.query('SELECT app.set_lock_timeout($1)', [ms]);
        expect(await show(runtime, 'lock_timeout')).toBe(ms === 1 ? '1ms' : '1min');
      });
    }
    for (const ms of [0, 60001, null]) {
      await inTransaction(runtime, async () => {
        await expect(runtime.query('SELECT app.set_lock_timeout($1)', [ms])).rejects.toMatchObject({
          code: '22023',
        });
      });
    }
  });

  it('SEC-R31 SEC-R48 neither PUBLIC nor scf_owner can execute the functions; scf_app alone holds EXECUTE', async () => {
    for (const fn of FUNCTIONS) {
      const holders = await owner.query<{ grantee: string }>(
        `SELECT CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee
         FROM pg_proc p, aclexplode(p.proacl) acl
         WHERE p.oid = $1::regprocedure AND acl.privilege_type = 'EXECUTE'`,
        [fn],
      );
      expect(holders.rows.map((row) => row.grantee)).toEqual(['scf_app']);

      const owners = await owner.query<{ owner: boolean }>(
        `SELECT has_function_privilege('scf_owner', $1, 'EXECUTE') AS owner`,
        [fn],
      );
      expect(owners.rows[0]?.owner).toBe(false);
    }

    await inTransaction(owner, async () => {
      await expect(owner.query('SELECT app.set_lock_timeout(300)')).rejects.toMatchObject({
        code: '42501',
      });
    });
  });

  describe('SEC-AC37', () => {
    const roleName = `scf_test_r_${randomBytes(4).toString('hex')}`;
    const password = randomBytes(18).toString('hex');

    beforeAll(async () => {
      // Generated from hex digits only, so safe to interpolate as an identifier and literal.
      await owner.query(`CREATE ROLE ${roleName} LOGIN PASSWORD '${password}'`);
      // Schema usage only, so the function's own EXECUTE privilege is what refuses R.
      await owner.query(`GRANT USAGE ON SCHEMA app TO ${roleName}`);
    });

    afterAll(async () => {
      await owner.query(`REVOKE USAGE ON SCHEMA app FROM ${roleName}`);
      await owner.query(`DROP ROLE IF EXISTS ${roleName}`);
    });

    it('SEC-AC37 the statement-timeout function is bounded, transaction-local and runtime-only', async () => {
      await runtime.query('BEGIN');
      await runtime.query('SELECT app.set_statement_timeout(600000)');
      const inside = await show(runtime, 'statement_timeout');
      await runtime.query('COMMIT');
      expect(inside).toBe('10min');
      expect(await show(runtime, 'statement_timeout')).toBe('5s');

      await inTransaction(runtime, async () => {
        await runtime.query('SELECT app.set_statement_timeout(3600000)');
        expect(await show(runtime, 'statement_timeout')).toBe('1h');
      });
      for (const ms of [0, 3600001]) {
        await inTransaction(runtime, async () => {
          await expect(
            runtime.query('SELECT app.set_statement_timeout($1)', [ms]),
          ).rejects.toMatchObject({ code: '22023' });
        });
      }

      const url = new URL(withDatabase(requireEnv('TEST_DATABASE_URL'), owner.database ?? ''));
      url.username = roleName;
      url.password = password;
      const other = new pg.Client({ connectionString: url.toString() });
      await other.connect();
      try {
        await expect(other.query('SELECT app.set_statement_timeout(600000)')).rejects.toMatchObject(
          { code: '42501', message: expect.stringContaining('function') as unknown },
        );
      } finally {
        await other.end();
      }
    });
  });
});
