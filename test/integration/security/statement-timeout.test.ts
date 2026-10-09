import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { buildProductionApp, SPEC_007_DEFAULTS } from '../../support/app.js';
import { createCustomerAccount, withScratchDatabase } from '../../support/db.js';
import { bearer, problemOf } from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';

describe('statement_timeout', () => {
  it('SEC-AC24 a statement cancelled by statement_timeout answers 503 with Retry-After, after one attempt, and is logged with SQLSTATE 57014', async () => {
    await withScratchDatabase(async (scratch) => {
      const c1Id = randomUUID();
      const pool = new pg.Pool({ connectionString: scratch.runtimeUrl, max: 1 });
      const a1 = await createCustomerAccount({ currency: 'EUR', ownerId: c1Id, pool });
      await pool.end();

      const built = buildProductionApp({
        env: { ...SPEC_007_DEFAULTS, DATABASE_URL: scratch.runtimeUrl },
      });
      const session = new pg.Client({ connectionString: scratch.ownerUrl });
      const clock = new pg.Client({ connectionString: scratch.ownerUrl });
      await session.connect();
      await clock.connect();
      /** The database server's own time, in milliseconds, from a session outside the test's lock. */
      const databaseNow = async (): Promise<number> => {
        const result = await clock.query<{ now: string }>(
          'SELECT (extract(epoch FROM clock_timestamp()) * 1000)::text AS now',
        );
        return Number(result.rows[0]?.now);
      };
      try {
        await built.app.ready();
        await session.query('BEGIN');
        await session.query('LOCK TABLE accounts IN ACCESS EXCLUSIVE MODE');
        const read = async (reqId: string) =>
          await built.app.inject({
            method: 'GET',
            url: `/v1/accounts/${a1.id}`,
            headers: { ...bearer(tokenFor(c1Id, 'customer')), 'x-request-id': reqId },
          });

        const started = await databaseNow();
        const blocked = await read('statement-timeout-read');
        const elapsed = (await databaseNow()) - started;
        await session.query('ROLLBACK');

        expect(blocked.statusCode).toBe(503);
        expect(problemOf(blocked).type).toBe('/problems/service-unavailable');
        expect(blocked.headers['retry-after']).toBe('1');
        // statement_timeout runs on the database server's clock, which in a Docker VM can drift from
        // the host's, so the elapsed time is measured on that clock, with clock_timestamp() read
        // from a separate session just before the read and just after its 503. The log line with
        // SQLSTATE 57014 below proves it was statement_timeout that answered.
        expect(elapsed).toBeGreaterThanOrEqual(5000);
        const unavailable = built.logs
          .linesOf('statement-timeout-read')
          .filter((line) => line.msg === 'service unavailable');
        expect(unavailable).toHaveLength(1);
        expect(unavailable[0]).toMatchObject({ sqlstate: '57014', cause: 'StatementTimeout' });

        expect((await read('statement-timeout-after')).statusCode).toBe(200);
      } finally {
        await session.end();
        await clock.end();
        await built.app.close();
      }
    });
  }, 30_000);
});
