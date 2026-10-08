import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { balanceOf, closePools } from '../../support/db.js';
import {
  createAccount,
  deposit,
  problemOf,
  transfer,
  withoutRequestId,
} from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';
import { rowsTouching } from './api-support.js';

const MAX = '9223372036854775807';

describe('the balance limit', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp({ env: { MAX_AMOUNT_MINOR: MAX } });
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('LED-AC21 a credit past the maximum balance answers 422, a transfer gets the same answer as to an unknown account, and nothing is written', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const c2 = tokenFor(randomUUID(), 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, c1, 'EUR');
    const b1 = await createAccount(built.app, c2, 'EUR');
    const u = randomUUID();
    expect((await deposit(built.app, o1, a1.id, MAX)).statusCode).toBe(201);
    expect((await deposit(built.app, o1, b1.id, '10')).statusCode).toBe(201);
    const before = await rowsTouching([a1.id, b1.id]);

    const deposited = await deposit(built.app, o1, a1.id, '1');
    const toA1 = await transfer(built.app, c2, b1.id, a1.id, '1');
    const toU = await transfer(built.app, c2, b1.id, u, '1');

    expect(deposited.statusCode).toBe(422);
    expect(problemOf(deposited).type).toBe('/problems/balance-limit-exceeded');
    expect(toA1.statusCode).toBe(422);
    expect(toU.statusCode).toBe(422);
    const toA1Body = problemOf(toA1);
    const toUBody = problemOf(toU);
    expect(toA1Body.type).toBe('/problems/destination-unavailable');
    expect(withoutRequestId(toA1Body)).toEqual(withoutRequestId(toUBody));
    expect(toA1Body.requestId).not.toBe(toUBody.requestId);

    expect(await balanceOf(a1.id)).toBe(MAX);
    expect(await balanceOf(b1.id)).toBe('10');
    expect(await rowsTouching([a1.id, b1.id])).toEqual(before);
    expect(await rowsTouching([u])).toEqual({ transactions: '0', entries: '0', audits: '0' });
  });
});
