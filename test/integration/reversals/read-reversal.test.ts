import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { closePools } from '../../support/db.js';
import {
  createAccount,
  deposit,
  problemOf,
  reverse,
  transfer,
  type TransactionJson,
} from '../../support/http.js';
import { idOf, readTransaction, users } from './support.js';

describe('reading a reversal', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('REV-AC25 an operator reads every entry of a reversal, each customer only the entries on their own accounts, and a stranger gets 404', async () => {
    const u = users();
    const a1 = await createAccount(built.app, u.c1);
    const b1 = await createAccount(built.app, u.c2);
    idOf(await deposit(built.app, u.o1, a1.id, '1000'));
    const t = idOf(await transfer(built.app, u.c1, a1.id, b1.id, '300'));
    const r = idOf(await reverse(built.app, u.o1, t));

    const byOperator = await readTransaction(built.app, u.o1, r);
    expect(byOperator.statusCode, byOperator.body).toBe(200);
    const operatorBody = byOperator.json<TransactionJson>();
    expect(operatorBody).toMatchObject({
      id: r,
      kind: 'reversal',
      amount: '300',
      currency: 'EUR',
      reversedTransactionId: t,
    });
    expect(operatorBody.entries).toHaveLength(2);
    expect(operatorBody.entries).toEqual(
      expect.arrayContaining([
        { accountId: a1.id, amount: '300' },
        { accountId: b1.id, amount: '-300' },
      ]),
    );

    const byC1 = await readTransaction(built.app, u.c1, r);
    expect(byC1.statusCode, byC1.body).toBe(200);
    const c1Body = byC1.json<TransactionJson>();
    expect(c1Body.reversedTransactionId).toBe(t);
    expect(c1Body.entries).toEqual([{ accountId: a1.id, amount: '300' }]);

    const byC2 = await readTransaction(built.app, u.c2, r);
    expect(byC2.statusCode, byC2.body).toBe(200);
    const c2Body = byC2.json<TransactionJson>();
    expect(c2Body.reversedTransactionId).toBe(t);
    expect(c2Body.entries).toEqual([{ accountId: b1.id, amount: '-300' }]);
    expect(byC2.body).not.toContain(a1.id);

    const byC3 = await readTransaction(built.app, u.c3, r);
    expect(byC3.statusCode, byC3.body).toBe(404);
    expect(problemOf(byC3).type).toBe('/problems/not-found');
  });
});
