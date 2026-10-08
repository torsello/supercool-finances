import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireEnv } from '../../support/env.js';

describe('runtime role settings', () => {
  let runtime: pg.Client;

  beforeAll(async () => {
    runtime = new pg.Client({ connectionString: requireEnv('TEST_DATABASE_URL') });
    await runtime.connect();
  });

  afterAll(async () => {
    await runtime.end();
  });

  it('SEC-R29 starts every scf_app session with statement_timeout 5s and idle_in_transaction_session_timeout 10s', async () => {
    const result = await runtime.query<{
      user: string;
      statement_timeout: string;
      idle_timeout: string;
    }>(
      `SELECT current_user AS user,
              current_setting('statement_timeout') AS statement_timeout,
              current_setting('idle_in_transaction_session_timeout') AS idle_timeout`,
    );

    expect(result.rows[0]).toEqual({
      user: 'scf_app',
      statement_timeout: '5s',
      idle_timeout: '10s',
    });
  });
});
