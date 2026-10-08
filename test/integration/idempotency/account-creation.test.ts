import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { closePools, runtimePool } from '../../support/db.js';
import { bearer, type AccountJson } from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';

async function accountsOf(ownerId: string): Promise<string[]> {
  const result = await runtimePool().query<{ id: string }>(
    'SELECT id FROM accounts WHERE owner_id = $1 ORDER BY id',
    [ownerId],
  );
  return result.rows.map((row) => row.id);
}

describe('account creation with and without a key', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('IDM-AC04 a key is optional on account creation: the same key replays, requests without a key create new accounts', async () => {
    const c1 = randomUUID();
    const token = tokenFor(c1, 'customer');
    expect(await accountsOf(c1)).toEqual([]);
    const create = (headers: Record<string, string>) =>
      built.app.inject({
        method: 'POST',
        url: '/v1/accounts',
        headers: { ...bearer(token), ...headers },
        payload: { currency: 'EUR' },
      });

    const first = await create({ 'idempotency-key': 'k1' });
    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();

    const replay = await create({ 'idempotency-key': 'k1' });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers.location).toBe(first.headers.location);
    expect(replay.rawPayload.equals(first.rawPayload)).toBe(true);
    expect(replay.headers['idempotent-replayed']).toBe('true');

    const ids = new Set([first.json<AccountJson>().id]);
    for (let i = 0; i < 2; i += 1) {
      const unkeyed = await create({});
      expect(unkeyed.statusCode).toBe(201);
      expect(unkeyed.headers['idempotent-replayed']).toBeUndefined();
      ids.add(unkeyed.json<AccountJson>().id);
    }
    expect(ids.size).toBe(3);
    expect(await accountsOf(c1)).toEqual([...ids].sort());
  });
});
