import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { bearer, createAccount, deposit, problemOf } from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';

interface Page {
  items: { id: string }[];
  nextCursor?: string;
}

/** Another 32-byte cursor secret, for a replica that must refuse the others' cursors. */
const OTHER_CURSOR_SECRET = 'another-32-byte-cursor-secret-!!';

describe('cursors across replicas', () => {
  let p1: BuiltApp;
  let p2: BuiltApp;
  let p3: BuiltApp;

  beforeAll(async () => {
    p1 = buildProductionApp();
    p2 = buildProductionApp();
    p3 = buildProductionApp({ env: { CURSOR_SECRET: OTHER_CURSOR_SECRET } });
    await Promise.all([p1.app.ready(), p2.app.ready(), p3.app.ready()]);
  });

  afterAll(async () => {
    await Promise.all([p1.app.close(), p2.app.close(), p3.app.close()]);
  });

  it('ACC-AC26 a cursor issued by one replica works on another with the same secret, and is refused by one with another', async () => {
    expect(Buffer.byteLength(OTHER_CURSOR_SECRET)).toBe(32);
    const c1 = tokenFor(randomUUID(), 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(p1.app, c1);
    for (let index = 0; index < 3; index += 1) {
      expect((await deposit(p1.app, o1, a1.id, '100')).statusCode).toBe(201);
    }
    const url = `/v1/accounts/${a1.id}/entries?limit=1`;
    const all = await p1.app.inject({
      method: 'GET',
      url: `/v1/accounts/${a1.id}/entries`,
      headers: bearer(c1),
    });
    const [e3, e2, e1] = all.json<Page>().items.map((entry) => entry.id);

    async function list(built: BuiltApp, cursor?: string) {
      return await built.app.inject({
        method: 'GET',
        url: cursor === undefined ? url : `${url}&cursor=${encodeURIComponent(cursor)}`,
        headers: bearer(c1),
      });
    }

    const first = (await list(p1)).json<Page>();
    expect(first.items.map((entry) => entry.id)).toEqual([e3]);
    const issued = first.nextCursor ?? '';
    expect(issued).not.toBe('');

    const seen: (string | undefined)[] = [];
    let cursor: string | undefined = issued;
    while (cursor !== undefined) {
      const response = await list(p2, cursor);
      expect(response.statusCode).toBe(200);
      const next = response.json<Page>();
      seen.push(...next.items.map((entry) => entry.id));
      cursor = next.nextCursor;
      expect(seen.length).toBeLessThanOrEqual(2);
    }
    expect(seen).toEqual([e2, e1]);

    const refused = await list(p3, issued);
    expect(refused.statusCode).toBe(400);
    expect(problemOf(refused).type).toBe('/problems/malformed-request');
  });
});
