import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PG_MIGRATE_LOCK_ID } from 'node-pg-migrate';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { runMigrateCommand } from '../../../src/platform/db/migrate.js';
import { withScratchDatabase } from '../../support/db.js';
import { MIGRATIONS_DIR, shippedMigrations } from '../../support/migrations.js';

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `npm run migrate:up` with `MIGRATION_DATABASE_URL` set, as a developer or CI would. */
function npmMigrateUp(databaseUrl: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', '--silent', 'migrate:up'], {
      env: { ...process.env, MIGRATION_DATABASE_URL: databaseUrl },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

/** The one JSON line the command prints. */
function report(run: Run): { direction: string; applied: string[] } {
  return JSON.parse(run.stdout.trim()) as { direction: string; applied: string[] };
}

async function query<T extends pg.QueryResultRow>(url: string, text: string): Promise<T[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(text)).rows;
  } finally {
    await client.end();
  }
}

async function appliedMigrations(url: string): Promise<string[]> {
  const rows = await query<{ name: string }>(url, 'SELECT name FROM pgmigrations ORDER BY id');
  return rows.map((row) => row.name);
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

describe('the migrate command', () => {
  it('DEP-R05 npm run migrate:up applies every shipped migration to an empty database as the owner role, which owns every table it creates', async () => {
    await withScratchDatabase(
      async (scratch) => {
        const run = await npmMigrateUp(scratch.ownerUrl);

        expect(run.code, run.stderr).toBe(0);
        expect(report(run)).toEqual({ direction: 'up', applied: shippedMigrations() });
        expect(await appliedMigrations(scratch.ownerUrl)).toEqual(shippedMigrations());
        const tables = await query<{ name: string; owner: string }>(
          scratch.ownerUrl,
          `SELECT schemaname || '.' || tablename AS name, tableowner AS owner FROM pg_tables
           WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`,
        );
        expect(tables.map((table) => table.name)).toContain('public.pgmigrations');
        expect(tables.map((table) => table.name)).toContain('public.ledger_entries');
        for (const table of tables) expect(table.owner, table.name).toBe('scf_owner');
      },
      { migrated: false },
    );
  });

  it('DEP-R04 a second run against an up-to-date database applies nothing and exits 0', async () => {
    await withScratchDatabase(
      async (scratch) => {
        expect((await npmMigrateUp(scratch.ownerUrl)).code).toBe(0);

        const again = await npmMigrateUp(scratch.ownerUrl);

        expect(again.code, again.stderr).toBe(0);
        expect(report(again)).toEqual({ direction: 'up', applied: [] });
        expect(await appliedMigrations(scratch.ownerUrl)).toEqual(shippedMigrations());
      },
      { migrated: false },
    );
  });

  it('DEP-R04 a failing migration exits 1 with its SQLSTATE on stderr, no credential, and is not recorded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scf-migrations-'));
    try {
      for (const name of shippedMigrations()) {
        copyFileSync(join(MIGRATIONS_DIR, `${name}.sql`), join(dir, `${name}.sql`));
      }
      writeFileSync(
        join(dir, '9999999999999_fails.sql'),
        '-- Up Migration\nSELECT * FROM no_such_table;\n\n-- Down Migration\n',
      );
      await withScratchDatabase(async (scratch) => {
        const stdout = capture();
        const stderr = capture();

        const code = await runMigrateCommand({
          argv: ['up'],
          databaseUrl: scratch.ownerUrl,
          stdout,
          stderr,
          dir,
        });

        expect(code).toBe(1);
        expect(stdout.text).toBe('');
        expect(stderr.text).toMatch(/^migrate: the migrations failed with SQLSTATE 42P01: /);
        expect(stderr.text).not.toContain(new URL(scratch.ownerUrl).password);
        expect(await appliedMigrations(scratch.ownerUrl)).toEqual(shippedMigrations());
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('DEP-R03 a connection failure exits 1 naming its system error code, never the URL', async () => {
    const stdout = capture();
    const stderr = capture();
    const url = 'postgres://scf_owner:a-password-never-printed@127.0.0.1:1/unreachable';

    const code = await runMigrateCommand({ argv: ['up'], databaseUrl: url, stdout, stderr });

    expect(code).toBe(1);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('migrate: the migrations failed (Error, ECONNREFUSED)\n');
    expect(stderr.text).not.toContain('a-password-never-printed');
    expect(stderr.text).not.toContain('127.0.0.1');
  });

  it('DEP-R04 a run started while another holds the migration lock fails at once with a fixed text naming the cause, and applies nothing', async () => {
    await withScratchDatabase(
      async (scratch) => {
        const holder = new pg.Client({ connectionString: scratch.ownerUrl });
        await holder.connect();
        try {
          await holder.query('SELECT pg_advisory_lock($1)', [PG_MIGRATE_LOCK_ID]);
          const stdout = capture();
          const stderr = capture();

          const code = await runMigrateCommand({
            argv: ['up'],
            databaseUrl: scratch.ownerUrl,
            stdout,
            stderr,
          });

          expect(code).toBe(1);
          expect(stdout.text).toBe('');
          expect(stderr.text).toBe(
            'migrate: another migration run holds the migration lock, so this run applied nothing; run it again once that one has ended\n',
          );
          const tables = await holder.query(
            "SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'pgmigrations'",
          );
          expect(tables.rowCount).toBe(0);
        } finally {
          await holder.end();
        }
      },
      { migrated: false },
    );
  });

  it('DEP-R04 a failed order check exits 1 with a fixed text naming the cause, and applies nothing', async () => {
    await withScratchDatabase(async (scratch) => {
      const [, second] = shippedMigrations();
      await query(scratch.ownerUrl, `DELETE FROM pgmigrations WHERE name = '${second ?? ''}'`);
      const before = await appliedMigrations(scratch.ownerUrl);
      const stdout = capture();
      const stderr = capture();

      const code = await runMigrateCommand({
        argv: ['up'],
        databaseUrl: scratch.ownerUrl,
        stdout,
        stderr,
      });

      expect(code).toBe(1);
      expect(stdout.text).toBe('');
      expect(stderr.text).toBe(
        'migrate: the order check failed: the migrations applied to the database are not a prefix of the shipped ones, so a migration is missing or out of order; nothing was applied\n',
      );
      expect(await appliedMigrations(scratch.ownerUrl)).toEqual(before);
    });
  });

  it('DEP-R05 refuses to run without MIGRATION_DATABASE_URL or with another argument than up or down', async () => {
    for (const [argv, databaseUrl, message] of [
      [['up'], undefined, 'migrate: MIGRATION_DATABASE_URL is not set\n'],
      [['up'], '', 'migrate: MIGRATION_DATABASE_URL is not set\n'],
      [[], 'postgres://unused@127.0.0.1:1/unused', 'migrate: usage: migrate up|down\n'],
      [['sideways'], 'postgres://unused@127.0.0.1:1/unused', 'migrate: usage: migrate up|down\n'],
      [['up', '5'], 'postgres://unused@127.0.0.1:1/unused', 'migrate: usage: migrate up|down\n'],
    ] as const) {
      const stdout = capture();
      const stderr = capture();

      const code = await runMigrateCommand({ argv, databaseUrl, stdout, stderr });

      expect(code).toBe(1);
      expect(stdout.text).toBe('');
      expect(stderr.text).toBe(message);
    }
  });
});
