import { afterAll, describe, expect, it } from 'vitest';
import { closePools, ownerPool, rejection, runtimePool } from '../../support/db.js';

const LEDGER_TABLES = ['accounts', 'transactions', 'ledger_entries'];

describe('runtime role privileges', () => {
  afterAll(async () => {
    await closePools();
  });

  it('LED-AC12 the runtime role cannot disable the ledger checks', async () => {
    const catalogue = ownerPool();
    const role = await catalogue.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'scf_app'`,
    );
    const owners = await catalogue.query<{ relname: string; owner: string }>(
      `SELECT relname, pg_get_userbyid(relowner) AS owner FROM pg_class
       WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1) ORDER BY relname`,
      [LEDGER_TABLES],
    );
    const tablePrivileges = await catalogue.query<{ relname: string; privileges: string[] }>(
      `SELECT c.relname, array_agg(acl.privilege_type ORDER BY acl.privilege_type) AS privileges
       FROM pg_class c, aclexplode(c.relacl) acl
       WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('transactions', 'ledger_entries')
         AND acl.grantee = 'scf_app'::regrole
       GROUP BY c.relname ORDER BY c.relname`,
    );
    const columnPrivileges = await catalogue.query(
      `SELECT a.attname FROM pg_attribute a, aclexplode(a.attacl) acl
       WHERE a.attrelid IN ('transactions'::regclass, 'ledger_entries'::regclass)
         AND acl.grantee = 'scf_app'::regrole`,
    );
    const memberships = await catalogue.query(
      `SELECT roleid::regrole::text FROM pg_auth_members WHERE member = 'scf_app'::regrole`,
    );

    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    expect(owners.rows.map((row) => row.relname)).toEqual([
      'accounts',
      'ledger_entries',
      'transactions',
    ]);
    for (const row of owners.rows) expect(row.owner).not.toBe('scf_app');
    expect(tablePrivileges.rows).toEqual([
      { relname: 'ledger_entries', privileges: ['INSERT', 'SELECT'] },
      { relname: 'transactions', privileges: ['INSERT', 'SELECT'] },
    ]);
    expect(columnPrivileges.rows).toEqual([]);
    expect(memberships.rows).toEqual([]);

    const app = await runtimePool().connect();
    try {
      const attempts = [
        'ALTER TABLE ledger_entries DISABLE TRIGGER ALL',
        'DROP TRIGGER ledger_entries_check_at_commit ON ledger_entries',
        'ALTER TABLE accounts DROP CONSTRAINT accounts_balance_check',
        'SET session_replication_role = replica',
      ];
      const codes: string[] = [];
      for (const attempt of attempts) codes.push((await rejection(app, attempt)).code ?? '');
      expect(codes).toEqual(['42501', '42501', '42501', '42501']);
    } finally {
      app.release();
    }
  });
});
