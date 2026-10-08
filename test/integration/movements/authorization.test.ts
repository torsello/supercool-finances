import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { balanceOf, closePools, settlementAccountId } from '../../support/db.js';
import {
  createAccount,
  deposit,
  problemOf,
  transfer,
  withdraw,
  withoutRequestId,
} from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';
import { transactionsOn } from './support.js';

describe('who may move money', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('MOV-AC04 a customer deposit and an operator withdrawal or transfer are forbidden, and another customer or a system or unknown account is not found', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const c2 = tokenFor(randomUUID(), 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, c1, 'EUR');
    const b1 = await createAccount(built.app, c2, 'EUR');
    expect((await deposit(built.app, o1, a1.id, '1000')).statusCode).toBe(201);
    expect((await deposit(built.app, o1, b1.id, '1000')).statusCode).toBe(201);
    const s = await settlementAccountId('EUR');
    const u = randomUUID();
    const before = await transactionsOn(a1.id, b1.id);

    const forbidden = [
      await deposit(built.app, c1, a1.id, '100'),
      await withdraw(built.app, o1, a1.id, '100'),
      await transfer(built.app, o1, a1.id, b1.id, '100'),
    ];
    for (const response of forbidden) {
      expect(response.statusCode).toBe(403);
      expect(problemOf(response).type).toBe('/problems/forbidden');
    }

    const notFound = [
      await withdraw(built.app, c2, a1.id, '100'),
      await transfer(built.app, c2, a1.id, b1.id, '100'),
      await withdraw(built.app, c1, s, '100'),
      await withdraw(built.app, c1, u, '100'),
    ];
    for (const response of notFound) {
      expect(response.statusCode).toBe(404);
      expect(problemOf(response).type).toBe('/problems/not-found');
    }

    const intoS = await deposit(built.app, o1, s, '100');
    const intoU = await deposit(built.app, o1, u, '100');
    expect(intoS.statusCode).toBe(404);
    expect(intoU.statusCode).toBe(404);
    expect(withoutRequestId(problemOf(intoS))).toEqual(withoutRequestId(problemOf(intoU)));
    expect(problemOf(intoU).type).toBe('/problems/not-found');

    expect(await balanceOf(a1.id)).toBe('1000');
    expect(await balanceOf(b1.id)).toBe('1000');
    expect(await transactionsOn(a1.id, b1.id)).toBe(before);
  });
});
