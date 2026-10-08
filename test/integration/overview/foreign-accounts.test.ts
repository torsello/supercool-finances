import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { balanceOf, closePools, settlementAccountId } from '../../support/db.js';
import {
  bearer,
  createAccount,
  deposit,
  problemOf,
  transfer,
  withdraw,
  withoutRequestId,
} from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';

describe('accounts a customer may not see (SYS-R05, SYS-R42)', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('SYS-AC03 answers a foreign, system, unknown or malformed account id with one 404 body and changes nothing', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const c2 = tokenFor(randomUUID(), 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, c1);
    const b1 = await createAccount(built.app, c2);
    expect((await deposit(built.app, o1, a1.id, '10000')).statusCode).toBe(201);
    expect((await deposit(built.app, o1, b1.id, '5000')).statusCode).toBe(201);
    const s = await settlementAccountId('EUR');
    const u = randomUUID();
    const v = 'not-a-uuid';

    const responses = [];
    for (const id of [b1.id, s, u, v]) {
      responses.push(
        await built.app.inject({ method: 'GET', url: `/v1/accounts/${id}`, headers: bearer(c1) }),
        await withdraw(built.app, c1, id, '100'),
        await transfer(built.app, c1, id, a1.id, '100'),
      );
    }

    expect(responses).toHaveLength(12);
    const bodies = responses.map((response) => {
      expect(response.statusCode, response.body).toBe(404);
      const body = problemOf(response);
      expect(body.type).toBe('/problems/not-found');
      return withoutRequestId(body);
    });
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    expect(await balanceOf(a1.id)).toBe('10000');
    expect(await balanceOf(b1.id)).toBe('5000');
  });
});
