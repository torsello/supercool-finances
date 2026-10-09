import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withScratchDatabase } from '../../support/db.js';
import { requireEnv } from '../../support/env.js';
import { shippedMigrations } from '../../support/migrations.js';

// ADR-0020: some ACs need an empty database with every migration applied (LED-AC06) or one whose
// committed data may drift (LED-AC16), so they never disturb the shared test database.
describe('scratch databases', () => {
  let owner: pg.Pool;

  beforeAll(() => {
    owner = new pg.Pool({ connectionString: requireEnv('TEST_MIGRATION_DATABASE_URL'), max: 1 });
  });

  afterAll(async () => {
    await owner.end();
  });

  async function databaseExists(name: string): Promise<boolean> {
    const result = await owner.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    return result.rowCount === 1;
  }

  it('creates a database, migrates it to the latest migration and drops it afterwards', async () => {
    const seen = await withScratchDatabase(async (scratch) => {
      expect(await databaseExists(scratch.name)).toBe(true);

      const runtime = new pg.Client({ connectionString: scratch.runtimeUrl });
      const ownerClient = new pg.Client({ connectionString: scratch.ownerUrl });
      await runtime.connect();
      await ownerClient.connect();
      try {
        const roles = await Promise.all(
          [runtime, ownerClient].map(async (client) => {
            const result = await client.query<{ user: string }>('SELECT current_user AS user');
            return result.rows[0]?.user;
          }),
        );
        const applied = await ownerClient.query<{ name: string }>(
          'SELECT name FROM pgmigrations ORDER BY run_on, id',
        );
        expect(roles).toEqual(['scf_app', 'scf_owner']);
        expect(applied.rows.map((row) => row.name)).toEqual(shippedMigrations());
        expect(applied.rows.length).toBeGreaterThan(0);
      } finally {
        await runtime.end();
        await ownerClient.end();
      }
      return scratch.name;
    });

    expect(await databaseExists(seen)).toBe(false);
  });

  it('leaves the database empty when asked not to migrate it', async () => {
    const seen = await withScratchDatabase(
      async (scratch) => {
        const client = new pg.Client({ connectionString: scratch.ownerUrl });
        await client.connect();
        try {
          const tables = await client.query(
            `SELECT 1 FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`,
          );
          expect(tables.rowCount).toBe(0);
        } finally {
          await client.end();
        }
        return scratch.name;
      },
      { migrated: false },
    );

    expect(await databaseExists(seen)).toBe(false);
  });

  it('drops the database also when the test body throws', async () => {
    let name = '';
    await expect(
      withScratchDatabase((scratch) => {
        name = scratch.name;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(name).not.toBe('');
    expect(await databaseExists(name)).toBe(false);
  });
});
