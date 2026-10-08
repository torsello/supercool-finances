import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { closePools, runtimePool } from '../../support/db.js';
import { bearer, problemOf, type AccountJson } from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';
import { keyRowOf } from './support.js';

async function accountsOf(ownerId: string): Promise<number> {
  const result = await runtimePool().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM accounts WHERE owner_id = $1',
    [ownerId],
  );
  return Number(result.rows[0]?.count);
}

describe('keyed requests over HTTP', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('IDM-R07 a replay carries the stored status, Content-Type, Location and bytes, the current X-Request-Id and Idempotent-Replayed: true', async () => {
    const c1 = randomUUID();
    const token = tokenFor(c1, 'customer');
    const send = () =>
      built.app.inject({
        method: 'POST',
        url: '/v1/accounts',
        headers: { ...bearer(token), 'idempotency-key': 'k1' },
        payload: { currency: 'EUR' },
      });

    const first = await send();
    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    const account = first.json<AccountJson>();
    expect(first.headers.location).toBe(`/v1/accounts/${account.id}`);
    const stored = await keyRowOf(c1, 'k1');
    expect(stored).toMatchObject({ status: 201 });
    expect(stored?.body?.equals(first.rawPayload)).toBe(true);

    const replay = await send();
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['content-type']).toBe(first.headers['content-type']);
    expect(replay.headers.location).toBe(first.headers.location);
    expect(replay.rawPayload.equals(first.rawPayload)).toBe(true);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    // The current request's correlation id, as its log lines carry it, not the first request's.
    const replayId = replay.headers['x-request-id'];
    expect(typeof replayId).toBe('string');
    expect(built.logs.linesOf(String(replayId))).not.toEqual([]);
    expect(await accountsOf(c1)).toBe(1);
    expect(await keyRowOf(c1, 'k1')).toEqual(stored);
  });

  it('IDM-R02 IDM-R03 account creation runs without a key, and answers 400 malformed-request for a malformed one without creating an account', async () => {
    const c1 = randomUUID();
    const token = tokenFor(c1, 'customer');
    for (const key of ['', 'a b', 'k'.repeat(256), 'é']) {
      const response = await built.app.inject({
        method: 'POST',
        url: '/v1/accounts',
        headers: { ...bearer(token), 'idempotency-key': key },
        payload: { currency: 'EUR' },
      });
      expect(response.statusCode, JSON.stringify(key)).toBe(400);
      expect(problemOf(response).type).toBe('/problems/malformed-request');
    }
    expect(await accountsOf(c1)).toBe(0);

    for (let i = 0; i < 2; i += 1) {
      const response = await built.app.inject({
        method: 'POST',
        url: '/v1/accounts',
        headers: bearer(token),
        payload: { currency: 'EUR' },
      });
      expect(response.statusCode).toBe(201);
      expect(response.headers['idempotent-replayed']).toBeUndefined();
    }
    expect(await accountsOf(c1)).toBe(2);
  });
});
