import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { closePools } from '../../support/db.js';
import { requireEnv } from '../../support/env.js';
import {
  bearer,
  changeStatus,
  createAccount,
  deposit,
  freshKey,
  reverse,
  transfer,
  withdraw,
  type MovementJson,
} from '../../support/http.js';
import { SqlCapture } from '../../support/sql-capture.js';
import { tokenFor } from '../../support/tokens.js';

/** Runs `body` on a new session of the runtime role, closed afterwards. */
async function runtimeSession<T>(body: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: requireEnv('TEST_DATABASE_URL') });
  await client.connect();
  try {
    return await body(client);
  } finally {
    await client.end();
  }
}

async function show(client: pg.ClientBase, setting: string): Promise<string> {
  // `setting` is one of a fixed list of names in this file, never input.
  const result = await client.query<Record<string, string>>(`SHOW ${setting}`);
  return result.rows[0]?.[setting] ?? '';
}

/** Whether a statement sets a session setting, which SEC-R30 forbids. */
function setsSession(text: string): boolean {
  const statement = text.trimStart();
  return /^(SET|RESET|DISCARD)\b/i.test(statement) || /set_config\(/i.test(statement);
}

describe('database sessions', () => {
  const capture = new SqlCapture();

  beforeAll(() => {
    capture.start();
  });

  afterAll(async () => {
    capture.stop();
    await closePools();
  });

  it('SEC-AC22 the timeouts live on the runtime role, and the service sends no SET, RESET, DISCARD or set_config and no connection options', async () => {
    const { statementTimeout, idleTimeout, settings } = await runtimeSession(async (client) => ({
      statementTimeout: await show(client, 'statement_timeout'),
      idleTimeout: await show(client, 'idle_in_transaction_session_timeout'),
      settings: (
        await client.query<{ setconfig: string[] }>(
          `SELECT s.setconfig FROM pg_db_role_setting s
            WHERE s.setrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)
              AND s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())`,
        )
      ).rows.flatMap((row) => row.setconfig),
    }));
    expect(statementTimeout).toBe('5s');
    expect(idleTimeout).toBe('10s');
    expect(settings).toEqual(
      expect.arrayContaining(['statement_timeout=5s', 'idle_in_transaction_session_timeout=10s']),
    );

    capture.clear();
    const built = buildProductionApp();
    let app: BuiltApp['app'] | undefined;
    try {
      app = built.app;
      await app.ready();
      const c1 = tokenFor(randomUUID(), 'customer');
      const c2 = tokenFor(randomUUID(), 'customer');
      const o1 = tokenFor(randomUUID(), 'operator');
      const created = await app.inject({
        method: 'POST',
        url: '/v1/accounts',
        headers: { ...bearer(c1), 'idempotency-key': freshKey() },
        payload: { currency: 'EUR' },
      });
      expect(created.statusCode).toBe(201);
      const a1 = created.json<{ id: string }>();
      const b1 = await createAccount(app, c2, 'EUR');
      const k1 = freshKey();
      const first = await deposit(app, o1, a1.id, '1000', { key: k1 });
      expect(first.statusCode).toBe(201);
      expect(
        (await deposit(app, o1, a1.id, '1000', { key: k1 })).headers['idempotent-replayed'],
      ).toBe('true');
      const withdrawal = await withdraw(app, c1, a1.id, '100');
      expect(withdrawal.statusCode).toBe(201);
      expect((await transfer(app, c1, a1.id, b1.id, '100')).statusCode).toBe(201);
      expect((await reverse(app, o1, withdrawal.json<MovementJson>().id)).statusCode).toBe(201);
      expect((await changeStatus(app, o1, b1.id, 'freeze')).statusCode).toBe(200);
      for (const url of [`/v1/accounts/${a1.id}`, `/v1/accounts/${a1.id}/entries`]) {
        expect((await app.inject({ method: 'GET', url, headers: bearer(c1) })).statusCode).toBe(
          200,
        );
      }
      expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);

      const texts = capture.texts();
      expect(texts.length).toBeGreaterThan(20);
      expect(texts.filter(setsSession)).toEqual([]);
      const pooled = await app.pool.connect();
      try {
        const parameters = (pooled as unknown as { connectionParameters: { options?: unknown } })
          .connectionParameters;
        expect(parameters.options).toBeUndefined();
      } finally {
        pooled.release();
      }
    } finally {
      await app?.close();
    }
  });

  it('SEC-AC23 a lock timeout set through the function lasts only until its transaction ends, also on the service pool connection', async () => {
    const roleDefault = await runtimeSession(async (client) => await show(client, 'lock_timeout'));
    for (const ending of ['COMMIT', 'ROLLBACK']) {
      const [inside, after] = await runtimeSession(async (client) => {
        await client.query('BEGIN');
        await client.query('SELECT app.set_lock_timeout(300)');
        const during = await show(client, 'lock_timeout');
        await client.query(ending);
        return [during, await show(client, 'lock_timeout')];
      });
      expect(inside, ending).toBe('300ms');
      expect(after, ending).toBe(roleDefault);
    }

    const built = buildProductionApp({
      env: { DB_POOL_MAX: '1', ACCOUNT_LOCK_TIMEOUT_MS: '300' },
    });
    try {
      await built.app.ready();
      const c1 = tokenFor(randomUUID(), 'customer');
      const a1 = await createAccount(built.app, c1, 'EUR');
      expect(
        (await deposit(built.app, tokenFor(randomUUID(), 'operator'), a1.id, '1000')).statusCode,
      ).toBe(201);

      capture.clear();
      expect((await withdraw(built.app, c1, a1.id, '100')).statusCode).toBe(201);
      const statements = capture.texts();
      expect(statements.filter((text) => text.includes('app.set_lock_timeout'))).toHaveLength(2);
      expect(statements.filter((text) => /set_config\(/i.test(text))).toEqual([]);

      const only = await built.app.pool.connect();
      try {
        expect(await show(only, 'lock_timeout')).toBe(roleDefault);
      } finally {
        only.release();
      }
    } finally {
      await built.app.close();
    }
  });
});
