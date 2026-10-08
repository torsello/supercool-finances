import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { runReconcile } from '../../../src/modules/ledger/adapters/cli/reconcile.js';
import { createPool } from '../../../src/platform/db/database.js';
import {
  createCustomerAccount,
  withScratchDatabase,
  writeDirectDeposit,
} from '../../support/db.js';

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `npm run reconcile` with DATABASE_URL set, as CI does (LED-R22). */
function npmReconcile(databaseUrl: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', 'reconcile'], {
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

/** npm prints its own header first, so the report is the last line of stdout (plan 002 section 7). */
function report(run: Run): unknown {
  const lines = run.stdout.trim().split('\n');
  return JSON.parse(lines.at(-1) ?? '');
}

const ZERO_TOTALS = ['USD', 'MXN', 'EUR', 'COP', 'JPY'].map((currency) => ({ currency, sum: '0' }));

const quietLogger = { warn: () => undefined };

describe('npm run reconcile', () => {
  it('LED-AC16 prints the report as JSON and exits 0 when clean, 1 on a discrepancy and 2 when it cannot run, never printing the password', async () => {
    await withScratchDatabase(async (scratch) => {
      const pool = createPool({
        connectionString: scratch.runtimeUrl,
        max: 2,
        logger: quietLogger,
      });
      let b1: { id: string };
      try {
        const a1 = await createCustomerAccount({ currency: 'EUR', pool });
        await writeDirectDeposit(a1, '1000', pool);
        b1 = await createCustomerAccount({ currency: 'EUR', pool });
        await writeDirectDeposit(b1, '500', pool);
      } finally {
        await pool.end();
      }

      const clean = await npmReconcile(scratch.runtimeUrl);
      expect(clean.code).toBe(0);
      expect(report(clean)).toEqual({ discrepancies: [], totals: ZERO_TOTALS });

      const drift = createPool({
        connectionString: scratch.runtimeUrl,
        max: 1,
        logger: quietLogger,
      });
      try {
        await drift.query('UPDATE accounts SET balance = 501 WHERE id = $1', [b1.id]);
      } finally {
        await drift.end();
      }
      const drifted = await npmReconcile(scratch.runtimeUrl);
      expect(drifted.code).toBe(1);
      expect(report(drifted)).toEqual({
        discrepancies: [
          {
            accountId: b1.id,
            currency: 'EUR',
            cachedBalance: '501',
            entriesSum: '500',
            difference: '1',
          },
        ],
        totals: ZERO_TOTALS.map((total) =>
          total.currency === 'EUR' ? { ...total, sum: '1' } : total,
        ),
      });

      // Port 1 is privileged and unused, so nothing listens there.
      const nowhere = new URL(scratch.runtimeUrl);
      nowhere.port = '1';
      const unreachable = await npmReconcile(nowhere.toString());
      expect(unreachable.code).toBe(2);

      const { password } = new URL(scratch.runtimeUrl);
      expect(password.length).toBeGreaterThan(0);
      for (const run of [clean, drifted, unreachable]) {
        expect(run.stdout).not.toContain(password);
        expect(run.stderr).not.toContain(password);
      }
      expect(unreachable.stderr).not.toContain(nowhere.toString());
    });
  }, 60_000);

  it('SEC-R48 calls app.set_statement_timeout(600000) inside its one REPEATABLE READ, READ ONLY transaction', async () => {
    await withScratchDatabase(async (scratch) => {
      const statements: string[] = [];
      let out = '';
      const code = await runReconcile({
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
                if (typeof args[0] === 'string') statements.push(args[0]);
                return query(...args);
              };
              return client;
            },
            end: () => pool.end(),
          };
        },
      });
      expect(code).toBe(0);
      expect(JSON.parse(out)).toEqual({ discrepancies: [], totals: ZERO_TOTALS });
      expect(statements[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      expect(statements[1]).toBe('SELECT app.set_statement_timeout(600000)');
      expect(statements.at(-1)).toBe('COMMIT');
      expect(statements.slice(2, -1)).toHaveLength(2);
      expect(statements.filter((text) => text.includes('set_statement_timeout'))).toHaveLength(1);
    });
  });
});
