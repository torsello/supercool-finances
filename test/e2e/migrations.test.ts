import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_USERS } from '../../scripts/seed.js';
import { readCompose } from '../support/deployment.js';
import { getAccount } from './support/api.js';
import { closeStackDb, stackDb } from './support/db.js';
import {
  ADDRESSES,
  compose,
  ensureStack,
  seedStack,
  toolsTokens,
  type SeedOutput,
} from './support/stack.js';

/** The role a connection URL of `compose.yaml` names. */
function roleOf(variable: 'DATABASE_URL' | 'MIGRATION_DATABASE_URL'): string {
  const value = readCompose().service('tools').environment[variable] ?? '';
  return decodeURIComponent(new URL(value).username);
}

describe('the migrations of the stack', () => {
  let seeded: SeedOutput;
  let token = '';

  beforeAll(async () => {
    await ensureStack();
    seeded = await seedStack();
    const c1 = DEMO_USERS.find((user) => user.name === 'demo-customer-1')?.id ?? '';
    [token = ''] = await toolsTokens([{ sub: c1, role: 'customer' }]);
  });

  afterAll(closeStackDb);

  it('DEP-AC04 migrations are repeatable and use their own role, the replicas the runtime role', async () => {
    const runtime = roleOf('DATABASE_URL');
    const owner = roleOf('MIGRATION_DATABASE_URL');
    expect(runtime).not.toBe(owner);

    const applied = async (): Promise<unknown[]> =>
      (
        await stackDb().query<Record<string, unknown>>(
          'SELECT id, name, run_on FROM pgmigrations ORDER BY id',
        )
      ).rows;
    const before = await applied();
    expect(before.length).toBeGreaterThan(0);

    const again = await compose(['run', '--rm', 'migrate']);
    expect(again.code, again.stderr).toBe(0);
    const printed = again.stdout.split('\n').find((line) => line.startsWith('{')) ?? '';
    expect(JSON.parse(printed)).toEqual({ direction: 'up', applied: [] });
    expect(await applied()).toEqual(before);

    // The replicas' sessions, read while C1, demo-customer-1, reads one of their accounts.
    const account = seeded.users.find((user) => user.name === 'demo-customer-1')?.accounts[0];
    const reads = Promise.all(
      Array.from({ length: 20 }, async () => await getAccount(token, account?.id ?? '')),
    );
    const sessions = await stackDb().query<{ address: string; role: string }>(
      `SELECT host(client_addr) AS address, usename AS role FROM pg_stat_activity
        WHERE host(client_addr) = ANY($1::text[])`,
      [[ADDRESSES['api-1'], ADDRESSES['api-2']]],
    );
    for (const response of await reads) expect(response.status).toBe(200);
    for (const replica of ['api-1', 'api-2'] as const) {
      const ofReplica = sessions.rows.filter((row) => row.address === ADDRESSES[replica]);
      expect(ofReplica.length, `sessions of ${replica}`).toBeGreaterThan(0);
      expect(new Set(ofReplica.map((row) => row.role)), replica).toEqual(new Set([runtime]));
    }

    // node-pg-migrate's table and every table the migrations create belong to the owner role.
    const tables = await stackDb().query<{ name: string; owner: string }>(
      `SELECT schemaname || '.' || tablename AS name, tableowner AS owner FROM pg_tables
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1`,
    );
    expect(tables.rows.map((row) => row.name)).toContain('public.pgmigrations');
    expect(tables.rows.length).toBeGreaterThan(5);
    for (const table of tables.rows) expect(table.owner, table.name).toBe(owner);
  });
});
