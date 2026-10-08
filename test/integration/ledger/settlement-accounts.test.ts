import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { rejection, withScratchDatabase } from '../../support/db.js';

describe('settlement accounts on an empty database', () => {
  it('LED-AC06 one settlement account per currency, without a cached balance', async () => {
    await withScratchDatabase(async ({ runtimeUrl }) => {
      const app = new pg.Client({ connectionString: runtimeUrl });
      await app.connect();
      try {
        const listed = await app.query<{
          code: string;
          currency: string;
          owner_id: string | null;
          balance: string | null;
        }>(`SELECT code, currency, owner_id, balance FROM accounts WHERE kind = 'system'`);
        const total = await app.query<{ count: string }>('SELECT count(*) FROM accounts');

        expect(listed.rows).toHaveLength(5);
        expect(total.rows[0]?.count).toBe('5');
        expect(new Set(listed.rows.map((row) => row.code))).toEqual(
          new Set(['USD', 'MXN', 'EUR', 'COP', 'JPY'].map((c) => `external-settlement:${c}`)),
        );
        for (const row of listed.rows) {
          expect(row).toEqual({
            code: `external-settlement:${row.currency}`,
            currency: row.currency,
            owner_id: null,
            balance: null,
          });
        }

        const secondEur = await rejection(
          app,
          `INSERT INTO accounts (id, kind, code, currency)
           VALUES ($1, 'system', 'external-settlement:EUR', 'EUR')`,
          [randomUUID()],
        );
        const systemWithBalance = await rejection(
          app,
          `INSERT INTO accounts (id, kind, code, currency, balance)
           VALUES ($1, 'system', 'external-settlement:EUR', 'EUR', 0)`,
          [randomUUID()],
        );
        const customerWithoutBalance = await rejection(
          app,
          `INSERT INTO accounts (id, kind, owner_id, currency, status)
           VALUES ($1, 'customer', $2, 'EUR', 'active')`,
          [randomUUID(), randomUUID()],
        );

        expect(secondEur.code).toBe('23505');
        expect(systemWithBalance).toMatchObject({
          code: '23514',
          constraint: 'accounts_kind_columns',
        });
        expect(customerWithoutBalance).toMatchObject({
          code: '23514',
          constraint: 'accounts_kind_columns',
        });
        const after = await app.query<{ count: string }>('SELECT count(*) FROM accounts');
        expect(after.rows[0]?.count).toBe('5');
      } finally {
        await app.end();
      }
    });
  });
});
