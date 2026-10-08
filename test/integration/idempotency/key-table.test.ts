import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePools, rejection, rollingBack, runtimePool } from '../../support/db.js';
import { refusedWrite } from '../ledger/direct-writes.js';

const FINGERPRINT = createHash('sha256').update('POST /v1/deposits {}').digest('hex');

const INSERT_PENDING = `INSERT INTO idempotency_keys (user_id, key, fingerprint, created_at, expires_at)
  VALUES ($1, $2, $3, now(), now() + interval '24 hours')`;

const INSERT_COMPLETE = `INSERT INTO idempotency_keys
  (user_id, key, fingerprint, status, headers, body, created_at, expires_at)
  VALUES ($1, $2, $3, 201, '{"content-type": "application/json"}', '\\x7b7d',
          now(), now() + interval '24 hours')`;

const COMPLETE = `UPDATE idempotency_keys
  SET status = 201, headers = '{"content-type": "application/json"}', body = '\\x7b7d'
  WHERE user_id = $1 AND key = $2`;

describe('idempotency key table', () => {
  let app: pg.PoolClient;

  beforeAll(async () => {
    app = await runtimePool().connect();
  });

  afterAll(async () => {
    app.release();
    await closePools();
  });

  async function rowsFor(userId: string, key: string): Promise<number> {
    const result = await app.query(
      'SELECT 1 FROM idempotency_keys WHERE user_id = $1 AND key = $2',
      [userId, key],
    );
    return result.rowCount ?? -1;
  }

  it('IDM-AC20 no key row is committed without a result', async () => {
    const c1 = randomUUID();

    const incomplete = await refusedWrite(app, () =>
      app.query(INSERT_PENDING, [c1, 'k9', FINGERPRINT]),
    );
    expect(incomplete).toMatchObject({
      at: 'commit',
      error: { code: '23514', constraint: 'idempotency_keys_complete' },
    });
    expect(await rowsFor(c1, 'k9')).toBe(0);

    await app.query('BEGIN');
    await app.query(INSERT_PENDING, [c1, 'k9', FINGERPRINT]);
    await app.query(COMPLETE, [c1, 'k9']);
    await app.query('COMMIT');
    expect(await rowsFor(c1, 'k9')).toBe(1);

    await app.query('DELETE FROM idempotency_keys WHERE user_id = $1', [c1]);
  });

  it('IDM-R04 keys are unique per user and compared exactly, case included', async () => {
    await rollingBack(app, async () => {
      const c1 = randomUUID();
      const c2 = randomUUID();
      for (const [user, key] of [
        [c1, 'order-1'],
        [c2, 'order-1'],
        [c1, 'ORDER-1'],
        [c1, 'order-1 '],
      ] as const) {
        await app.query(INSERT_COMPLETE, [user, key, FINGERPRINT]);
      }
      await app.query('SAVEPOINT duplicate');
      await expect(app.query(INSERT_COMPLETE, [c1, 'order-1', FINGERPRINT])).rejects.toMatchObject({
        code: '23505',
        constraint: 'idempotency_keys_pkey',
      });
      await app.query('ROLLBACK TO SAVEPOINT duplicate');
      const stored = await app.query<{ count: string }>(
        'SELECT count(*) FROM idempotency_keys WHERE user_id = ANY($1::uuid[])',
        [[c1, c2]],
      );
      expect(stored.rows[0]?.count).toBe('4');
    });
  });

  it('IDM-R18 refuses a key of 256 characters and a fingerprint that is not 64 lowercase hex characters', async () => {
    await rollingBack(app, async () => {
      await app.query(INSERT_COMPLETE, [randomUUID(), 'k'.repeat(255), FINGERPRINT]);
    });
    const tooLong = await rejection(app, INSERT_COMPLETE, [
      randomUUID(),
      'k'.repeat(256),
      FINGERPRINT,
    ]);
    expect(tooLong.code).toBe('23514');

    for (const fingerprint of [
      FINGERPRINT.toUpperCase(),
      FINGERPRINT.slice(0, 63),
      `${FINGERPRINT.slice(0, 63)}g`,
    ]) {
      const error = await rejection(app, INSERT_COMPLETE, [randomUUID(), 'k1', fingerprint]);
      expect(error.code).toBe('23514');
    }
  });

  it('IDM-R18 scf_app can update and delete key rows', async () => {
    await rollingBack(app, async () => {
      const c1 = randomUUID();
      await app.query(INSERT_COMPLETE, [c1, 'k1', FINGERPRINT]);
      const updated = await app.query(
        `UPDATE idempotency_keys SET expires_at = now() WHERE user_id = $1 AND key = 'k1'`,
        [c1],
      );
      const deleted = await app.query('DELETE FROM idempotency_keys WHERE user_id = $1', [c1]);
      expect([updated.rowCount, deleted.rowCount]).toEqual([1, 1]);
    });
  });
});
