import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { closePools, runtimePool } from '../../support/db.js';
import { bearer, createAccount, problemOf, type AccountJson } from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';

/** The accounts a user owns in the database, whatever the API says. */
async function accountsOwnedBy(ownerId: string): Promise<{ id: string; currency: string }[]> {
  const result = await runtimePool().query<{ id: string; currency: string }>(
    'SELECT id, currency FROM accounts WHERE owner_id = $1 ORDER BY id',
    [ownerId],
  );
  return result.rows;
}

async function accountCount(): Promise<string> {
  const result = await runtimePool().query<{ count: string }>('SELECT count(*) FROM accounts');
  return result.rows[0]?.count ?? '';
}

describe('account creation', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  async function list(token: string): Promise<AccountJson[]> {
    const response = await built.app.inject({
      method: 'GET',
      url: '/v1/accounts?limit=100',
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ items: AccountJson[] }>().items;
  }

  it('ACC-AC01 a customer creates an active EUR account with balance "0", located under /v1, and reads the same body', async () => {
    const c1 = randomUUID();
    const token = tokenFor(c1, 'customer');
    expect(await accountsOwnedBy(c1)).toEqual([]);

    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: bearer(token),
      payload: { currency: 'EUR' },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json<AccountJson>();
    // Every Location carries the full path, /v1 included (SYS-R43).
    expect(response.headers['location']).toBe(`/v1/accounts/${body.id}`);
    expect(body).toEqual({
      id: body.id,
      currency: 'EUR',
      status: 'active',
      balance: '0',
      createdAt: body.createdAt,
      updatedAt: body.createdAt,
    });
    expect(body.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    const read = await built.app.inject({
      method: 'GET',
      url: `/v1/accounts/${body.id}`,
      headers: bearer(token),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(body);
    expect(await accountsOwnedBy(c1)).toEqual([{ id: body.id, currency: 'EUR' }]);
  });

  it('ACC-AC02 a customer holds several accounts, two in EUR and one in JPY, and lists exactly those', async () => {
    const c1 = randomUUID();
    const token = tokenFor(c1, 'customer');
    const created = [
      await createAccount(built.app, token, 'EUR'),
      await createAccount(built.app, token, 'EUR'),
      await createAccount(built.app, token, 'JPY'),
    ];
    expect(new Set(created.map((account) => account.id)).size).toBe(3);
    expect(created.map((account) => account.currency)).toEqual(['EUR', 'EUR', 'JPY']);
    for (const account of created) {
      expect(account).toMatchObject({ status: 'active', balance: '0' });
    }
    const listed = await list(token);
    expect(listed.map((account) => account.id).sort()).toEqual(
      created.map((account) => account.id).sort(),
    );
  });

  it('ACC-AC04 two creations without Idempotency-Key make two accounts with different ids', async () => {
    const c1 = randomUUID();
    const token = tokenFor(c1, 'customer');
    const first = await built.app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: bearer(token),
      payload: { currency: 'EUR' },
    });
    const second = await built.app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: bearer(token),
      payload: { currency: 'EUR' },
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json<AccountJson>().id).not.toBe(second.json<AccountJson>().id);
    const owned = await accountsOwnedBy(c1);
    expect(owned).toHaveLength(2);
    expect(owned.every((account) => account.currency === 'EUR')).toBe(true);
  });

  it('ACC-AC05 an unsupported or malformed currency answers 422 with one errors entry for currency, and creates no account', async () => {
    const c1 = randomUUID();
    const token = tokenFor(c1, 'customer');
    for (const payload of [
      { currency: 'GBP' },
      { currency: 'eur' },
      { currency: 'EURO' },
      { currency: '' },
      { currency: 978 },
      { currency: null },
      {},
    ]) {
      const response = await built.app.inject({
        method: 'POST',
        url: '/v1/accounts',
        headers: bearer(token),
        payload,
      });
      const label = JSON.stringify(payload);
      expect(response.statusCode, label).toBe(422);
      const body = problemOf(response);
      expect(body.type, label).toBe('/problems/validation-error');
      expect(body['errors'], label).toEqual([
        { pointer: '/currency', detail: expect.any(String) as unknown },
      ]);
    }
    expect(await accountsOwnedBy(c1)).toEqual([]);
    expect(await list(token)).toEqual([]);
  });

  it('ACC-AC06 an operator cannot create an account: 403 forbidden, and no account is created', async () => {
    const o1 = randomUUID();
    const before = await accountCount();
    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: bearer(tokenFor(o1, 'operator')),
      payload: { currency: 'EUR' },
    });
    expect(response.statusCode).toBe(403);
    expect(problemOf(response).type).toBe('/problems/forbidden');
    expect(await accountCount()).toBe(before);
    expect(await accountsOwnedBy(o1)).toEqual([]);
  });
});
