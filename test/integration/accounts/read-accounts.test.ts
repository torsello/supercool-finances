import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { closePools, settlementAccountId } from '../../support/db.js';
import {
  bearer,
  changeStatus,
  createAccount,
  deposit,
  problemOf,
  withoutRequestId,
  type AccountJson,
} from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';

interface PageJson {
  items: AccountJson[];
  nextCursor?: string;
}

interface EntryJson {
  id: string;
  transactionId: string;
  kind: string;
  amount: string;
  currency: string;
  createdAt: string;
}

describe('reading and listing accounts', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  const operator = tokenFor(randomUUID(), 'operator');

  async function get(token: string, url: string) {
    return await built.app.inject({ method: 'GET', url, headers: bearer(token) });
  }

  async function funded(token: string, currency: string, amount: string): Promise<AccountJson> {
    const account = await createAccount(built.app, token, currency);
    const response = await deposit(built.app, operator, account.id, amount, { currency });
    expect(response.statusCode).toBe(201);
    return account;
  }

  it('ACC-AC07 a customer reads their own accounts with exactly the six fields and balances as strings', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const a1 = await funded(c1, 'EUR', '1050');
    const j1 = await funded(c1, 'JPY', '1500');

    for (const [account, balance] of [
      [a1, '1050'],
      [j1, '1500'],
    ] as const) {
      const response = await get(c1, `/v1/accounts/${account.id}`);
      expect(response.statusCode).toBe(200);
      const body = response.json<AccountJson>();
      expect(Object.keys(body).sort()).toEqual(
        ['balance', 'createdAt', 'currency', 'id', 'status', 'updatedAt'].sort(),
      );
      expect(body).toMatchObject({
        id: account.id,
        currency: account.currency,
        status: 'active',
        balance,
      });
      expect(typeof body.balance).toBe('string');
      expect(body.updatedAt >= body.createdAt).toBe(true);
    }
  });

  it('ACC-AC10 an operator reads any customer account with its ownerId, and lists its history', async () => {
    const c1 = randomUUID();
    const c2 = randomUUID();
    const a1 = await funded(tokenFor(c1, 'customer'), 'EUR', '1000');
    const b1 = await createAccount(built.app, tokenFor(c2, 'customer'));

    for (const [account, ownerId, balance] of [
      [a1, c1, '1000'],
      [b1, c2, '0'],
    ] as const) {
      const response = await get(operator, `/v1/accounts/${account.id}`);
      expect(response.statusCode).toBe(200);
      const body = response.json<AccountJson>();
      expect(Object.keys(body).sort()).toEqual(
        ['balance', 'createdAt', 'currency', 'id', 'ownerId', 'status', 'updatedAt'].sort(),
      );
      expect(body).toMatchObject({ id: account.id, ownerId, balance, status: 'active' });
    }

    const history = await get(operator, `/v1/accounts/${a1.id}/entries`);
    expect(history.statusCode).toBe(200);
    const items = history.json<{ items: EntryJson[] }>().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'deposit', amount: '1000', currency: 'EUR' });
  });

  it('ACC-AC22 the settlement account is never visible: not in a customer list, 404 to a customer and to an operator', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const a1 = await funded(c1, 'EUR', '1000');
    const s = await settlementAccountId('EUR');

    const list = await get(c1, '/v1/accounts');
    expect(list.statusCode).toBe(200);
    expect(list.json<PageJson>().items.map((account) => account.id)).toEqual([a1.id]);

    const bodies = [];
    for (const token of [c1, operator]) {
      for (const url of [`/v1/accounts/${s}`, `/v1/accounts/${s}/entries`]) {
        const response = await get(token, url);
        expect(response.statusCode, url).toBe(404);
        const body = problemOf(response);
        expect(body.type).toBe('/problems/not-found');
        bodies.push(withoutRequestId(body));
      }
    }
    expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
  });

  it('ACC-AC08 a customer lists their accounts in pages of 2, newest first, in every status, and never sees another customer’s', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const c2 = tokenFor(randomUUID(), 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const created: AccountJson[] = [];
    for (let index = 0; index < 5; index += 1) created.push(await createAccount(built.app, c1));
    const [p1, p2, p3, p4, p5] = created.map((account) => account.id);
    const b1 = await createAccount(built.app, c2);
    expect((await changeStatus(built.app, o1, p2 ?? '', 'freeze')).statusCode).toBe(200);
    expect((await changeStatus(built.app, o1, p4 ?? '', 'close')).statusCode).toBe(200);

    const pages: PageJson[] = [];
    let url = '/v1/accounts?limit=2';
    for (;;) {
      const response = await built.app.inject({ method: 'GET', url, headers: bearer(c1) });
      expect(response.statusCode).toBe(200);
      const page = response.json<PageJson>();
      pages.push(page);
      if (page.nextCursor === undefined) break;
      url = `/v1/accounts?limit=2&cursor=${encodeURIComponent(page.nextCursor)}`;
      expect(pages.length).toBeLessThan(5);
    }

    expect(pages.map((page) => page.items.length)).toEqual([2, 2, 1]);
    expect('nextCursor' in (pages.at(-1) ?? {})).toBe(false);
    const items = pages.flatMap((page) => page.items);
    expect(items.map((account) => account.id)).toEqual([p5, p4, p3, p2, p1]);
    expect(items.find((account) => account.id === p2)?.status).toBe('frozen');
    expect(items.find((account) => account.id === p4)?.status).toBe('closed');
    expect(items.some((account) => account.id === b1.id)).toBe(false);
    for (const item of items) expect('ownerId' in item).toBe(false);
  });

  it('ACC-AC09 another customer’s account, an unknown id and an id that is not a UUID all answer 404, never 403', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const c2 = tokenFor(randomUUID(), 'customer');
    await createAccount(built.app, c1);
    const b1 = await createAccount(built.app, c2);
    const ids = [b1.id, randomUUID(), 'not-a-uuid'];

    for (const suffix of ['', '/entries']) {
      const bodies = [];
      for (const id of ids) {
        const response = await built.app.inject({
          method: 'GET',
          url: `/v1/accounts/${id}${suffix}`,
          headers: bearer(c1),
        });
        expect(response.statusCode, `${id}${suffix}`).toBe(404);
        const body = problemOf(response);
        expect(body.type).toBe('/problems/not-found');
        bodies.push(withoutRequestId(body));
      }
      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[2]).toEqual(bodies[0]);
    }
  });

  it('ACC-AC24 an operator cannot list accounts: 403 forbidden and no account in the body', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const c2 = tokenFor(randomUUID(), 'customer');
    const a1 = await createAccount(built.app, c1);
    const b1 = await createAccount(built.app, c2);

    const response = await built.app.inject({
      method: 'GET',
      url: '/v1/accounts',
      headers: bearer(tokenFor(randomUUID(), 'operator')),
    });
    expect(response.statusCode).toBe(403);
    expect(problemOf(response).type).toBe('/problems/forbidden');
    expect(response.body).not.toContain(a1.id);
    expect(response.body).not.toContain(b1.id);
    expect(response.body).not.toContain('items');
  });
});
