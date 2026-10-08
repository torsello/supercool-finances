import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { closePools, settlementAccountId } from '../../support/db.js';
import {
  bearer,
  createAccount,
  deposit,
  problemOf,
  transfer,
  withdraw,
  type AccountJson,
} from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';

interface EntryJson {
  id: string;
  transactionId: string;
  kind: string;
  amount: string;
  currency: string;
  createdAt: string;
}

interface Page<T> {
  items: T[];
  nextCursor?: string;
}

describe('account history', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  const o1 = tokenFor(randomUUID(), 'operator');

  async function get(token: string, url: string) {
    return await built.app.inject({ method: 'GET', url, headers: bearer(token) });
  }

  async function page<T>(token: string, url: string): Promise<Page<T>> {
    const response = await get(token, url);
    expect(response.statusCode, url).toBe(200);
    return response.json<Page<T>>();
  }

  function withCursor(url: string, cursor: string): string {
    return `${url}${url.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}`;
  }

  /** Deposits into an account `count` times, one entry each, in order. */
  async function deposits(account: AccountJson, count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      expect((await deposit(built.app, o1, account.id, '100')).statusCode).toBe(201);
    }
  }

  it('ACC-AC18 a customer reads the history of their account, newest first, with only its own entries', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const c2 = tokenFor(randomUUID(), 'customer');
    const a1 = await createAccount(built.app, c1);
    const b1 = await createAccount(built.app, c2);
    expect((await deposit(built.app, o1, a1.id, '5000')).statusCode).toBe(201);
    expect((await withdraw(built.app, c1, a1.id, '1200')).statusCode).toBe(201);
    expect((await transfer(built.app, c1, a1.id, b1.id, '300')).statusCode).toBe(201);

    const response = await get(c1, `/v1/accounts/${a1.id}/entries`);
    expect(response.statusCode).toBe(200);
    const items = response.json<Page<EntryJson>>().items;
    expect(items.map(({ kind, amount }) => ({ kind, amount }))).toEqual([
      { kind: 'transfer', amount: '-300' },
      { kind: 'withdrawal', amount: '-1200' },
      { kind: 'deposit', amount: '5000' },
    ]);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(
        ['amount', 'createdAt', 'currency', 'id', 'kind', 'transactionId'].sort(),
      );
      expect(item.currency).toBe('EUR');
    }
    const order = items.map((item) => [item.createdAt, item.id].join(' '));
    expect([...order].sort().reverse()).toEqual(order);

    // No entry of B1 or of a system account: none of their ids or entry ids appear.
    const b1Entries = (await page<EntryJson>(c2, `/v1/accounts/${b1.id}/entries`)).items;
    expect(b1Entries).toHaveLength(1);
    for (const entry of b1Entries) expect(response.body).not.toContain(entry.id);
    expect(response.body).not.toContain(b1.id);
    expect(response.body).not.toContain(await settlementAccountId('EUR'));
  });

  it('ACC-AC19 paging through a history is stable while a new entry arrives, which only a new first page shows', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const a1 = await createAccount(built.app, c1);
    await deposits(a1, 5);
    const url = `/v1/accounts/${a1.id}/entries?limit=2`;
    const all = (await page<EntryJson>(c1, `/v1/accounts/${a1.id}/entries`)).items;
    expect(all).toHaveLength(5);

    const first = await page<EntryJson>(c1, url);
    expect((await deposit(built.app, o1, a1.id, '100')).statusCode).toBe(201);
    const pages = [first];
    let cursor = first.nextCursor;
    while (cursor !== undefined) {
      const next = await page<EntryJson>(c1, withCursor(url, cursor));
      pages.push(next);
      cursor = next.nextCursor;
    }

    expect(pages.map((current) => current.items.length)).toEqual([2, 2, 1]);
    expect(pages.flatMap((current) => current.items)).toEqual(all);
    const fresh = await page<EntryJson>(c1, url);
    const e6 = fresh.items[0];
    expect(all.some((entry) => entry.id === e6?.id)).toBe(false);
    expect(fresh.items[1]).toEqual(all[0]);
  });

  it('ACC-AC21 an altered, random, foreign or other-list cursor answers 400, and an invalid limit 422', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const c2 = tokenFor(randomUUID(), 'customer');
    const a1 = await createAccount(built.app, c1);
    const a2 = await createAccount(built.app, c1);
    await createAccount(built.app, c2);
    await deposits(a1, 3);
    await deposits(a2, 3);
    const a1History = `/v1/accounts/${a1.id}/entries?limit=1`;
    const k = (await page<EntryJson>(c1, a1History)).nextCursor ?? '';
    expect(k).not.toBe('');
    const listCursor = (await page<AccountJson>(c1, '/v1/accounts?limit=1')).nextCursor ?? '';
    expect(listCursor).not.toBe('');

    const middle = Math.floor(k.length / 2);
    const altered = `${k.slice(0, middle)}${k[middle] === 'A' ? 'B' : 'A'}${k.slice(middle + 1)}`;
    const cursorRequests: [string, string][] = [
      [c1, withCursor(a1History, altered)],
      [c1, withCursor(a1History, randomBytes(48).toString('base64url'))],
      [c1, withCursor(`/v1/accounts/${a2.id}/entries?limit=1`, k)],
      [c1, withCursor(a1History, listCursor)],
      [c2, withCursor('/v1/accounts?limit=1', listCursor)],
    ];
    for (const [token, url] of cursorRequests) {
      const response = await get(token, url);
      expect(response.statusCode, url).toBe(400);
      expect(problemOf(response).type, url).toBe('/problems/malformed-request');
    }

    for (const limit of ['0', '101', 'abc']) {
      const response = await get(c1, `/v1/accounts/${a1.id}/entries?limit=${limit}`);
      expect(response.statusCode, limit).toBe(422);
      const body = problemOf(response);
      expect(body.type, limit).toBe('/problems/validation-error');
      expect(body['errors'], limit).toEqual([
        expect.objectContaining({ parameter: 'limit' }) as unknown,
      ]);
    }
  });

  it('ACC-AC27 without limit both lists answer pages of 20 with only items and nextCursor, then the last 5 with only items', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const accounts: AccountJson[] = [];
    for (let index = 0; index < 25; index += 1) accounts.push(await createAccount(built.app, c1));
    const a1 = accounts[0];
    if (a1 === undefined) throw new Error('no account');
    await deposits(a1, 25);

    for (const url of ['/v1/accounts', `/v1/accounts/${a1.id}/entries`]) {
      const first = await page<unknown>(c1, url);
      expect(Object.keys(first).sort(), url).toEqual(['items', 'nextCursor']);
      expect(first.items, url).toHaveLength(20);
      expect(typeof first.nextCursor, url).toBe('string');
      const second = await page<unknown>(c1, withCursor(url, first.nextCursor ?? ''));
      expect(Object.keys(second), url).toEqual(['items']);
      expect(second.items, url).toHaveLength(5);
    }
  });
});
