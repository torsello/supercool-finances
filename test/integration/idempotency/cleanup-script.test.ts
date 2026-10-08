import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  CLEANUP_BATCH_SIZE,
  runCleanup,
} from '../../../src/modules/idempotency/adapters/cli/cleanup.js';
import { createPool } from '../../../src/platform/db/database.js';
import { withScratchDatabase } from '../../support/db.js';

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `npm run idempotency:cleanup` with DATABASE_URL set, as the scheduled task does. */
function npmCleanup(databaseUrl: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', 'idempotency:cleanup'], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
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

/** npm prints its own header first, so the report is the last line of stdout (plan 005 section 6). */
function report(run: Run): unknown {
  const lines = run.stdout.trim().split('\n');
  return JSON.parse(lines.at(-1) ?? '');
}

const quietLogger = { warn: () => undefined };

/** Complete key rows of one user, expired or not, written directly as the runtime role. */
async function insertKeyRows(
  url: string,
  userId: string,
  rows: { key: string; expired: boolean }[],
): Promise<void> {
  const pool = createPool({ connectionString: url, max: 1, logger: quietLogger });
  try {
    await pool.query(
      `INSERT INTO idempotency_keys
         (user_id, key, fingerprint, status, headers, body, created_at, expires_at)
       SELECT $1, row.key, repeat('a', 64), 201, '{"content-type": "application/json"}', '\\x7b7d',
              CASE WHEN row.expired THEN now() - interval '2 days' ELSE now() END,
              CASE WHEN row.expired THEN now() - interval '1 day' ELSE now() + interval '1 day' END
       FROM unnest($2::text[], $3::boolean[]) AS row(key, expired)`,
      [userId, rows.map((row) => row.key), rows.map((row) => row.expired)],
    );
  } finally {
    await pool.end();
  }
}

async function keysOf(url: string, userId: string): Promise<string[]> {
  const pool = createPool({ connectionString: url, max: 1, logger: quietLogger });
  try {
    const result = await pool.query<{ key: string }>(
      'SELECT key FROM idempotency_keys WHERE user_id = $1 ORDER BY key',
      [userId],
    );
    return result.rows.map((row) => row.key);
  } finally {
    await pool.end();
  }
}

describe('npm run idempotency:cleanup', () => {
  it('IDM-AC24 deletes expired keys only, skipping a locked one without waiting, prints the count, exits 0, and exits 2 when it cannot run, never printing the password', async () => {
    await withScratchDatabase(async (scratch) => {
      const c1 = randomUUID();
      await insertKeyRows(scratch.runtimeUrl, c1, [
        { key: 'e1', expired: true },
        { key: 'e2', expired: true },
        { key: 'n1', expired: false },
      ]);

      // A separate session on the scratch database holds the row of e2.
      const session = new pg.Client({ connectionString: scratch.ownerUrl });
      await session.connect();
      let first: Run;
      try {
        await session.query('BEGIN');
        await session.query(
          `SELECT 1 FROM idempotency_keys WHERE user_id = $1 AND key = 'e2' FOR UPDATE`,
          [c1],
        );
        // Awaited while the session keeps its lock: the run completes before it is released.
        first = await npmCleanup(scratch.runtimeUrl);
        expect(await keysOf(scratch.runtimeUrl, c1)).toEqual(['e2', 'n1']);
        await session.query('ROLLBACK');
      } finally {
        await session.end();
      }
      expect(first.code).toBe(0);
      expect(report(first)).toEqual({ deleted: 1 });

      const second = await npmCleanup(scratch.runtimeUrl);
      expect(second.code).toBe(0);
      expect(report(second)).toEqual({ deleted: 1 });
      expect(await keysOf(scratch.runtimeUrl, c1)).toEqual(['n1']);

      // Port 1 is privileged and unused, so nothing listens there.
      const nowhere = new URL(scratch.runtimeUrl);
      nowhere.port = '1';
      const unreachable = await npmCleanup(nowhere.toString());
      expect(unreachable.code).toBe(2);

      const { password } = new URL(scratch.runtimeUrl);
      expect(password.length).toBeGreaterThan(0);
      for (const run of [first, second, unreachable]) {
        expect(run.stdout).not.toContain(password);
        expect(run.stderr).not.toContain(password);
      }
      expect(unreachable.stderr).not.toContain(nowhere.toString());
    });
  }, 60_000);

  it('SEC-R48 IDM-R22 deletes in batches of 1000, each in its own transaction that first calls app.set_statement_timeout(600000)', async () => {
    await withScratchDatabase(async (scratch) => {
      const c1 = randomUUID();
      await insertKeyRows(
        scratch.runtimeUrl,
        c1,
        Array.from({ length: CLEANUP_BATCH_SIZE + 1 }, (_, i) => ({
          key: `e${String(i)}`,
          expired: true,
        })).concat([{ key: 'n1', expired: false }]),
      );

      const statements: string[] = [];
      let out = '';
      const code = await runCleanup({
        databaseUrl: scratch.runtimeUrl,
        stdout: { write: (text: string) => (out += text) },
        stderr: { write: () => true },
        openPool: (connectionString) => {
          const pool = createPool({ connectionString, max: 1, logger: quietLogger });
          return {
            async connect() {
              const client = await pool.connect();
              const recorded = client as unknown as { query?: (...args: unknown[]) => unknown };
              const query = client.query.bind(client) as (...args: unknown[]) => unknown;
              recorded.query = (...args) => {
                if (typeof args[0] === 'string') statements.push(args[0].replace(/\s+/g, ' '));
                return query(...args);
              };
              return client;
            },
            end: () => pool.end(),
          };
        },
      });

      expect(CLEANUP_BATCH_SIZE).toBe(1000);
      expect(code).toBe(0);
      expect(JSON.parse(out)).toEqual({ deleted: 1001 });
      const batch = [
        'BEGIN',
        'SELECT app.set_statement_timeout(600000)',
        expect.stringMatching(
          /^WITH doomed AS \( ?SELECT .* FOR UPDATE SKIP LOCKED ?\) DELETE /,
        ) as string,
        'COMMIT',
      ];
      expect(statements).toEqual([...batch, ...batch]);
      expect(await keysOf(scratch.runtimeUrl, c1)).toEqual(['n1']);
    });
  }, 60_000);

  it('IDM-R22 exits 2 with a fixed message when DATABASE_URL is not set', async () => {
    let err = '';
    const code = await runCleanup({
      databaseUrl: undefined,
      stdout: { write: () => true },
      stderr: { write: (text: string) => (err += text) },
    });
    expect(code).toBe(2);
    expect(err).toBe('idempotency-cleanup: DATABASE_URL is not set\n');
  });
});
