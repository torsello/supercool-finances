import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { blockedBackends } from '../../support/backends.js';
import {
  closePools,
  createCustomerAccount,
  withScratchDatabase,
  writeDirectDeposit,
} from '../../support/db.js';
import { requireEnv } from '../../support/env.js';
import { problemOf, withdraw, withoutRequestId } from '../../support/http.js';
import { LOG_LEVEL } from '../../support/logs.js';
import { migrate, shippedMigrations } from '../../support/migrations.js';
import { openLockSession } from '../../support/sessions.js';
import { tokenFor } from '../../support/tokens.js';

/** A database URL whose host and port nothing listens on, with the runtime role's credentials. */
function unreachable(url: string): string {
  const parsed = new URL(url);
  parsed.host = '127.0.0.1:1';
  return parsed.toString();
}

describe('health checks', () => {
  const apps: BuiltApp[] = [];

  afterAll(async () => {
    await Promise.all(
      apps.map(async ({ app }) => {
        await app.close();
      }),
    );
    await closePools();
  });

  async function started(env: Record<string, string>): Promise<BuiltApp> {
    const built = buildProductionApp({ env });
    apps.push(built);
    await built.app.ready();
    return built;
  }

  async function ready(built: BuiltApp) {
    const started = performance.now();
    const response = await built.app.inject({ method: 'GET', url: '/health/ready' });
    return { response, ms: performance.now() - started };
  }

  it('SEC-AC18 /health/live answers ok with the database and Redis down, and is not served under /v1', async () => {
    const built = await started({
      DATABASE_URL: unreachable(requireEnv('TEST_DATABASE_URL')),
      REDIS_URL: 'redis://127.0.0.1:1',
    });

    const live = await built.app.inject({ method: 'GET', url: '/health/live' });
    expect(live.statusCode).toBe(200);
    expect(live.body).toBe('{"status":"ok"}');
    const prefixed = await built.app.inject({ method: 'GET', url: '/v1/health/live' });
    expect(prefixed.statusCode).toBe(404);
  });

  it('SEC-AC19 /health/ready checks the database and the shipped migrations on its own connection, and names the failed check only in the log', async () => {
    const shipped = shippedMigrations();
    const last = shipped[shipped.length - 1] ?? '';

    await withScratchDatabase(async (d2) => {
      await migrate(d2.ownerUrl, 'down', 1);
      await withScratchDatabase(async (d3) => {
        const owner = new pg.Client({ connectionString: d3.ownerUrl });
        await owner.connect();
        try {
          await owner.query(
            `INSERT INTO pgmigrations (name, run_on) VALUES ('9999999999999_not-shipped', now())`,
          );
        } finally {
          await owner.end();
        }

        const d1App = await started({});
        const d2App = await started({ DATABASE_URL: d2.runtimeUrl });
        const d3App = await started({ DATABASE_URL: d3.runtimeUrl });
        const d4App = await started({ DATABASE_URL: unreachable(requireEnv('TEST_DATABASE_URL')) });
        try {
          for (const built of [d1App, d3App]) {
            const { response } = await ready(built);
            expect(response.statusCode).toBe(200);
            expect(response.body).toBe('{"status":"ready"}');
          }
          const failed = [];
          for (const [built, check] of [
            [d2App, 'migrations'],
            [d4App, 'database'],
          ] as const) {
            const { response, ms } = await ready(built);
            expect(response.statusCode, check).toBe(503);
            expect(ms, check).toBeLessThan(5000);
            const body = problemOf(response);
            expect(body.type).toBe('/problems/service-unavailable');
            // The requestId is random, so only the rest of the body is searched.
            const text = JSON.stringify(withoutRequestId(body));
            for (const leak of [
              '127.0.0.1',
              'localhost',
              '55432',
              'ECONNREFUSED',
              '42501',
              'permission',
              'pgmigrations',
              last,
              d2.name,
            ]) {
              expect(text.includes(leak), `${check}: ${leak}`).toBe(false);
            }
            const warnings = built.logs
              .lines()
              .filter((line) => line.level === LOG_LEVEL.warn && line['check'] === check);
            expect(warnings, check).toHaveLength(1);
            failed.push(withoutRequestId(body));
          }
          expect(failed[0]).toEqual(failed[1]);
        } finally {
          // The scratch databases are dropped once every connection to them is closed.
          for (const built of [d2App, d3App]) await built.app.close();
        }
      });
    });
  });

  it('SEC-AC19 readiness answers while every pool connection waits for a lock', async () => {
    const built = await started({ DB_POOL_MAX: '1' });
    const c1Id = randomUUID();
    const a1 = await createCustomerAccount({ currency: 'EUR', ownerId: c1Id });
    await writeDirectDeposit(a1, '1000');
    const session = await openLockSession();
    try {
      await session.lockRow('accounts', a1.id);
      const withdrawal = withdraw(built.app, tokenFor(c1Id, 'customer'), a1.id, '100');
      await blockedBackends({ count: 1, by: session.pid });

      const { response } = await ready(built);
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('{"status":"ready"}');

      await session.release();
      expect((await withdrawal).statusCode).toBe(201);
    } finally {
      await session.close();
    }
  });
});
