import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireEnv } from '../../support/env.js';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('settlement accounts', () => {
  let runtime: pg.Client;

  beforeAll(async () => {
    runtime = new pg.Client({ connectionString: requireEnv('TEST_DATABASE_URL') });
    await runtime.connect();
  });

  afterAll(async () => {
    await runtime.end();
  });

  it('LED-R08 LED-R13 the test database holds one settlement account per currency, with its code, no owner and no cached balance', async () => {
    const result = await runtime.query<{
      id: string;
      code: string;
      currency: string;
      owner_id: string | null;
      status: string | null;
      balance: string | null;
    }>(
      `SELECT id, code, currency, owner_id, status, balance FROM accounts
       WHERE kind = 'system' ORDER BY code`,
    );

    expect(result.rows.map((row) => ({ ...row, id: undefined }))).toEqual(
      ['COP', 'EUR', 'JPY', 'MXN', 'USD'].map((currency) => ({
        id: undefined,
        code: `external-settlement:${currency}`,
        currency,
        owner_id: null,
        status: null,
        balance: null,
      })),
    );
    for (const row of result.rows) expect(row.id).toMatch(UUID_V7);
  });
});
