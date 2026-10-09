import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  runBootstrapCommand,
  type BootstrapClient,
} from '../../../src/platform/db/bootstrap-roles.js';
import { migrate } from '../../../src/platform/db/migrate.js';
import { closePools, ownerPool } from '../../support/db.js';
import { requireEnv } from '../../support/env.js';
import { MIGRATIONS_DIR, shippedMigrations } from '../../support/migrations.js';

interface Recorded {
  text: string;
  values: readonly unknown[];
}

/** Collects what a command writes. */
function capture(): { write(text: string): void; text: string } {
  return {
    text: '',
    write(text) {
      this.text += text;
    },
  };
}

/** `url` with another user, password and database; an empty password removes it. */
function urlFor(base: string, user: string, password: string, database: string): string {
  const url = new URL(base);
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

async function withClient<T>(url: string, body: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await body(client);
  } finally {
    await client.end();
  }
}

/** Whether `user` can log in to `database` with `password`. */
async function connects(base: string, user: string, password: string, database: string) {
  try {
    await withClient(urlFor(base, user, password, database), async (client) => {
      await client.query('SELECT 1');
    });
    return true;
  } catch {
    return false;
  }
}

describe('the bootstrap command', () => {
  const suffix = randomBytes(4).toString('hex');
  /** M stands for the RDS master user: LOGIN CREATEROLE CREATEDB, owner of the database. */
  const master = `scf_boot_master_${suffix}`;
  const masterPassword = `master-pass-${suffix}`;
  const ownerRole = `scf_boot_owner_${suffix}`;
  const runtimeRole = `scf_boot_app_${suffix}`;
  const database = `scf_boot_db_${suffix}`;
  /** A role M did not create, so M holds no admin option on it and cannot change its password. */
  const foreignRole = `scf_boot_foreign_${suffix}`;
  const foreignPassword = `foreign-pass-${suffix}`;
  const failingOwner = `scf_boot_owner2_${suffix}`;
  const base = requireEnv('TEST_MIGRATION_DATABASE_URL');
  const testDatabase = new URL(base).pathname.slice(1);
  const masterUrl = urlFor(base, master, '', database);
  const recorded: Recorded[] = [];
  const outputs: string[] = [];

  beforeAll(async () => {
    // The names are built from hex digits above, so they are safe identifiers.
    await ownerPool().query(
      `CREATE ROLE ${master} WITH LOGIN CREATEROLE CREATEDB PASSWORD '${masterPassword}'`,
    );
    await withClient(urlFor(base, master, masterPassword, testDatabase), async (client) => {
      await client.query(`CREATE DATABASE ${database}`);
    });
  });

  afterAll(async () => {
    await withClient(urlFor(base, master, masterPassword, testDatabase), async (client) => {
      // The database belongs to O by now; M, which created O, may act as O to drop it.
      await client
        .query(`GRANT ${ownerRole} TO CURRENT_USER WITH SET TRUE, INHERIT FALSE`)
        .catch(() => undefined);
      await client.query(`SET ROLE ${ownerRole}`).catch(() => undefined);
      await client.query(`DROP DATABASE IF EXISTS ${database}`);
      await client.query('RESET ROLE');
      await client.query(`DROP ROLE IF EXISTS ${ownerRole}`);
      await client.query(`DROP ROLE IF EXISTS ${runtimeRole}`);
    });
    await ownerPool().query(`DROP ROLE IF EXISTS ${foreignRole}`);
    await ownerPool().query(`DROP ROLE IF EXISTS ${master}`);
    await closePools();
  });

  /** Runs the command as the operator would, with the statements it sends recorded. */
  /** What the server answered to a failed statement: message, detail, hint and context. */
  const serverErrors: string[] = [];

  async function bootstrap(
    passwords: { owner?: string; runtime?: string },
    roles: { owner: string; runtime: string } = { owner: ownerRole, runtime: runtimeRole },
  ) {
    const stdout = capture();
    const stderr = capture();
    const env: Record<string, string | undefined> = {
      BOOTSTRAP_DATABASE_URL: masterUrl,
      PGPASSWORD: masterPassword,
      OWNER_ROLE_PASSWORD: passwords.owner,
      RUNTIME_ROLE_PASSWORD: passwords.runtime,
    };
    const code = await runBootstrapCommand({
      env,
      stdout,
      stderr,
      roles,
      connect: async (connectionString): Promise<BootstrapClient> => {
        const client = new pg.Client({ connectionString });
        await client.connect();
        return {
          query: async (text: string, values: readonly unknown[] = []) => {
            recorded.push({ text, values });
            try {
              return await client.query(text, [...values]);
            } catch (error) {
              if (error instanceof pg.DatabaseError) {
                serverErrors.push(
                  [error.message, error.detail, error.hint, error.where, error.internalQuery]
                    .filter((part) => part !== undefined)
                    .join(' | '),
                );
              }
              throw error;
            }
          },
          end: async () => {
            await client.end();
          },
        };
      },
    });
    outputs.push(stdout.text, stderr.text);
    return { code, stdout: stdout.text, stderr: stderr.text };
  }

  /** The shipped migrations with the role names replaced by O and R, in a temporary folder. */
  function renamedMigrations(): string {
    const dir = mkdtempSync(join(tmpdir(), 'scf-boot-migrations-'));
    for (const name of shippedMigrations()) {
      const sql = readFileSync(join(MIGRATIONS_DIR, `${name}.sql`), 'utf8')
        .replaceAll('scf_owner', ownerRole)
        .replaceAll('scf_app', runtimeRole);
      writeFileSync(join(dir, `${name}.sql`), sql);
    }
    return dir;
  }

  it('DEP-AC27 creates the roles once with only their attributes, applies a rotation, refuses a missing or non-ASCII password, and never shows a password, a verifier or the URL', async () => {
    // First run: everything is created.
    const first = await bootstrap({ owner: 'owner-pass-1', runtime: 'runtime-pass-1' });
    expect(first.code, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual({
      created: [ownerRole, runtimeRole],
      passwordsSet: [ownerRole, runtimeRole],
      grant: 'created',
      databaseOwner: 'set',
    });

    const roles = await withClient(urlFor(base, master, masterPassword, database), (client) =>
      client.query<{
        rolname: string;
        rolcanlogin: boolean;
        rolcreaterole: boolean;
        rolsuper: boolean;
        rolcreatedb: boolean;
        rolreplication: boolean;
        rolbypassrls: boolean;
      }>(
        `SELECT rolname, rolcanlogin, rolcreaterole, rolsuper, rolcreatedb, rolreplication,
                rolbypassrls
           FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname`,
        [[ownerRole, runtimeRole]],
      ),
    );
    const attributes = {
      rolsuper: false,
      rolcreatedb: false,
      rolreplication: false,
      rolbypassrls: false,
    };
    expect(roles.rows).toEqual([
      { rolname: runtimeRole, rolcanlogin: true, rolcreaterole: false, ...attributes },
      { rolname: ownerRole, rolcanlogin: true, rolcreaterole: true, ...attributes },
    ]);
    const membership = await withClient(urlFor(base, master, masterPassword, database), (client) =>
      client.query<{ admin_option: boolean; inherit_option: boolean; set_option: boolean }>(
        `SELECT admin_option, inherit_option, set_option FROM pg_auth_members
          WHERE roleid = $1::regrole AND member = $2::regrole`,
        [runtimeRole, ownerRole],
      ),
    );
    expect(membership.rows).toEqual([
      { admin_option: true, inherit_option: false, set_option: false },
    ]);
    const databaseOwner = await withClient(
      urlFor(base, master, masterPassword, database),
      (client) =>
        client.query<{ owner: string }>(
          'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1',
          [database],
        ),
    );
    expect(databaseOwner.rows).toEqual([{ owner: ownerRole }]);
    // M keeps no SET membership in O after the run.
    const masterInOwner = await withClient(
      urlFor(base, master, masterPassword, database),
      (client) =>
        client.query<{ set_option: boolean }>(
          `SELECT set_option FROM pg_auth_members WHERE roleid = $1::regrole AND member = $2::regrole`,
          [ownerRole, master],
        ),
    );
    expect(masterInOwner.rows.every((row) => !row.set_option)).toBe(true);
    expect(await connects(base, ownerRole, 'owner-pass-1', database)).toBe(true);
    expect(await connects(base, runtimeRole, 'runtime-pass-1', database)).toBe(true);

    // The migrations run as O, the owner role, with nothing else granted.
    const dir = renamedMigrations();
    try {
      const applied = await migrate({
        databaseUrl: urlFor(base, ownerRole, 'owner-pass-1', database),
        direction: 'up',
        dir,
      });
      expect(applied).toEqual(shippedMigrations());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // Second run with the same values: nothing is created.
    const second = await bootstrap({ owner: 'owner-pass-1', runtime: 'runtime-pass-1' });
    expect(second.code, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout)).toEqual({
      created: [],
      passwordsSet: [ownerRole, runtimeRole],
      grant: 'unchanged',
      databaseOwner: 'unchanged',
    });
    expect(await connects(base, ownerRole, 'owner-pass-1', database)).toBe(true);
    expect(await connects(base, runtimeRole, 'runtime-pass-1', database)).toBe(true);

    // Third run: a rotation of the owner's password.
    const third = await bootstrap({ owner: 'owner-pass-2', runtime: 'runtime-pass-1' });
    expect(third.code, third.stderr).toBe(0);
    expect(await connects(base, ownerRole, 'owner-pass-2', database)).toBe(true);
    expect(await connects(base, ownerRole, 'owner-pass-1', database)).toBe(false);

    // Fourth and fifth runs: refused, nothing changed.
    for (const runtime of [undefined, 'runtime-pass-é']) {
      const sent = recorded.length;
      const refused = await bootstrap({ owner: 'owner-pass-3', runtime });
      expect(refused.code).toBe(1);
      expect(refused.stdout).toBe('');
      expect(refused.stderr).toMatch(/^bootstrap: RUNTIME_ROLE_PASSWORD /);
      expect(refused.stderr.trim().split('\n')).toHaveLength(1);
      expect(recorded.length).toBe(sent);
      expect(await connects(base, ownerRole, 'owner-pass-2', database)).toBe(true);
      expect(await connects(base, ownerRole, 'owner-pass-3', database)).toBe(false);
    }

    // What was sent and printed.
    const verifiers = recorded.flatMap((entry) =>
      entry.values.filter(
        (value): value is string => typeof value === 'string' && value.startsWith('SCRAM-SHA-256'),
      ),
    );
    expect(verifiers.length).toBe(6);
    for (const verifier of verifiers) {
      expect(verifier).toMatch(
        /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/,
      );
    }
    const passwords = [
      'owner-pass-1',
      'owner-pass-2',
      'owner-pass-3',
      'runtime-pass-1',
      'runtime-pass-é',
      masterPassword,
    ];
    const statementTexts = recorded.map((entry) => entry.text);
    const otherValues = recorded.flatMap((entry) =>
      entry.values.filter((value) => !verifiers.includes(value as string)).map(String),
    );
    for (const text of [...statementTexts, ...otherValues, ...outputs]) {
      for (const secret of [...passwords, ...verifiers, masterUrl, 'SCRAM-SHA-256']) {
        expect(text.includes(secret), `"${text.slice(0, 80)}" holds a secret`).toBe(false);
      }
    }
  });

  it('DEP-R39 a statement that fails changes nothing and prints one line with its SQLSTATE, and no error holds a password or a verifier', async () => {
    await ownerPool().query(`CREATE ROLE ${foreignRole} WITH LOGIN PASSWORD '${foreignPassword}'`);
    const sent = recorded.length;
    const errors = serverErrors.length;

    // A new owner role and an existing runtime role whose password M may not set (42501).
    const failed = await bootstrap(
      { owner: 'owner-pass-x', runtime: 'runtime-pass-x' },
      { owner: failingOwner, runtime: foreignRole },
    );

    expect(failed.code).toBe(1);
    expect(failed.stdout).toBe('');
    expect(failed.stderr).toBe(
      'bootstrap: a statement failed with SQLSTATE 42501; nothing was changed\n',
    );
    // Rolled back: the owner role created in the transaction does not exist, and the foreign role
    // keeps its password.
    const created = await ownerPool().query('SELECT 1 FROM pg_roles WHERE rolname = $1', [
      failingOwner,
    ]);
    expect(created.rowCount).toBe(0);
    expect(await connects(base, foreignRole, foreignPassword, testDatabase)).toBe(true);
    expect(await connects(base, foreignRole, 'runtime-pass-x', testDatabase)).toBe(false);

    // The server's error carries neither the statement nor the verifier it was given.
    const newErrors = serverErrors.slice(errors);
    expect(newErrors).toHaveLength(1);
    expect(newErrors[0]).toContain('setting the password failed');
    const verifiers = recorded
      .slice(sent)
      .flatMap((entry) =>
        entry.values.filter(
          (value): value is string =>
            typeof value === 'string' && value.startsWith('SCRAM-SHA-256'),
        ),
      );
    expect(verifiers.length).toBeGreaterThan(0);
    for (const text of [...newErrors, failed.stderr]) {
      for (const secret of [
        ...verifiers,
        'SCRAM-SHA-256',
        'ALTER ROLE',
        'owner-pass-x',
        'runtime-pass-x',
        masterPassword,
      ]) {
        expect(text.includes(secret), `"${text}" holds ${secret}`).toBe(false);
      }
    }
  });
});
