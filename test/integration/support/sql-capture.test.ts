import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { requireEnv } from '../../support/env.js';
import { SqlCapture } from '../../support/sql-capture.js';

describe('the SQL capture', () => {
  const pool = new pg.Pool({ connectionString: requireEnv('TEST_DATABASE_URL'), max: 2 });

  afterAll(async () => {
    await pool.end();
  });

  it('records every statement of a pool connection, in order, with its values and the client that sent it, and stops recording when stopped', async () => {
    const capture = new SqlCapture();
    capture.start();
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT $1::int AS n', [1]);
        await client.query({ text: 'SELECT 2 AS n' });
        await client.query({ text: 'SELECT $1::int AS n', values: [5] });
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      await pool.query('SELECT 3 AS n');
    } finally {
      capture.stop();
    }
    await pool.query('SELECT 4 AS n');

    expect(capture.texts()).toEqual([
      'BEGIN',
      'SELECT $1::int AS n',
      'SELECT 2 AS n',
      'SELECT $1::int AS n',
      'COMMIT',
      'SELECT 3 AS n',
    ]);
    expect(capture.statements.map((statement) => statement.values)).toEqual([
      [],
      [1],
      [],
      [5],
      [],
      [],
    ]);
    const first = capture.statements[0]?.client;
    expect(capture.statements.slice(0, 5).every((statement) => statement.client === first)).toBe(
      true,
    );
  });
});
