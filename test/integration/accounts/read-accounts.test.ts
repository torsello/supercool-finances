import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import {
  bearer,
  changeStatus,
  createAccount,
  problemOf,
  withoutRequestId,
  type AccountJson,
} from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';

interface PageJson {
  items: AccountJson[];
  nextCursor?: string;
}

describe('reading and listing accounts', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
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
