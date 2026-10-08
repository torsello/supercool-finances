import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { balanceOf, closePools } from '../../support/db.js';
import {
  createAccount,
  deposit,
  problemOf,
  reverse,
  transfer,
  withoutRequestId,
} from '../../support/http.js';
import { footprint, idOf, reversalsOf, users } from './support.js';

describe('who may reverse what', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('REV-AC04 a customer reversing any transaction, theirs, another, a reversal, an unknown or a malformed id, gets one 403 and changes nothing', async () => {
    const u = users();
    const a1 = await createAccount(built.app, u.c1);
    const b1 = await createAccount(built.app, u.c2);
    const d = idOf(await deposit(built.app, u.o1, a1.id, '1000'));
    const t = idOf(await transfer(built.app, u.c1, a1.id, b1.id, '100'));
    const r = idOf(await reverse(built.app, u.o1, t));
    const before = await footprint([a1.id, b1.id]);

    const responses = [
      await reverse(built.app, u.c1, d),
      await reverse(built.app, u.c1, t),
      await reverse(built.app, u.c1, r),
      await reverse(built.app, u.c2, d),
      await reverse(built.app, u.c1, randomUUID()),
      await reverse(built.app, u.c1, 'not-a-uuid'),
    ];

    const bodies = responses.map((response) => {
      expect(response.statusCode, response.body).toBe(403);
      const body = problemOf(response);
      expect(body.type).toBe('/problems/forbidden');
      return withoutRequestId(body);
    });
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    expect(await reversalsOf(d)).toEqual([]);
    expect(await balanceOf(a1.id)).toBe('1000');
    expect(await balanceOf(b1.id)).toBe('0');
    expect(await footprint([a1.id, b1.id])).toEqual(before);
  });

  it('REV-AC05 an operator reversing an unknown id, a malformed id or an account id gets one 404 and changes nothing', async () => {
    const u = users();
    const a1 = await createAccount(built.app, u.c1);
    idOf(await deposit(built.app, u.o1, a1.id, '1000'));
    const before = await footprint([a1.id]);

    const responses = [
      await reverse(built.app, u.o1, randomUUID()),
      await reverse(built.app, u.o1, 'not-a-uuid'),
      await reverse(built.app, u.o1, a1.id),
    ];

    const bodies = responses.map((response) => {
      expect(response.statusCode, response.body).toBe(404);
      const body = problemOf(response);
      expect(body.type).toBe('/problems/not-found');
      return withoutRequestId(body);
    });
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    expect(await balanceOf(a1.id)).toBe('1000');
    expect(await footprint([a1.id])).toEqual(before);
  });
});
