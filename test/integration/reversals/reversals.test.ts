import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { balanceOf, closePools, settlementAccountId } from '../../support/db.js';
import {
  bearer,
  createAccount,
  deposit,
  reverse,
  transfer,
  withdraw,
  type MovementJson,
  type TransactionJson,
} from '../../support/http.js';
import { settlementSum } from '../movements/support.js';
import { entriesRead, idOf, readTransaction, users } from './support.js';

describe('reversals of each kind of movement', () => {
  let built: BuiltApp;
  let s: string;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
    s = await settlementAccountId('EUR');
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('REV-AC01 reversing a deposit adds a compensating transaction, leaves the original as it was and lists both in the history', async () => {
    const u = users();
    const a1 = await createAccount(built.app, u.c1);
    const d = idOf(await deposit(built.app, u.o1, a1.id, '5000'));
    const before = await readTransaction(built.app, u.o1, d);
    expect(before.statusCode).toBe(200);
    const settlementBefore = await settlementSum(s);

    const response = await reverse(built.app, u.o1, d, { reason: 'Duplicate deposit from rail' });

    expect(response.statusCode, response.body).toBe(201);
    const body = response.json<MovementJson & { reversedTransactionId: string }>();
    expect(Object.keys(body).sort()).toEqual(
      ['amount', 'createdAt', 'currency', 'id', 'kind', 'reversedTransactionId'].sort(),
    );
    expect(body).toEqual({
      id: body.id,
      kind: 'reversal',
      amount: '5000',
      currency: 'EUR',
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) as unknown,
      reversedTransactionId: d,
    });
    expect(response.headers.location).toBe(`/v1/transactions/${body.id}`);
    expect(await balanceOf(a1.id)).toBe('0');
    expect(await entriesRead(built.app, u.o1, body.id)).toEqual(
      [
        [a1.id, '-5000'],
        [s, '5000'],
      ].sort(),
    );
    expect((await settlementSum(s)) - settlementBefore).toBe(5000n);

    const original = await readTransaction(built.app, u.o1, d);
    expect(original.statusCode).toBe(200);
    const originalBody = original.json<TransactionJson>();
    const beforeBody = before.json<TransactionJson>();
    expect(originalBody).toMatchObject({ kind: 'deposit', amount: '5000' });
    expect(originalBody.createdAt).toBe(beforeBody.createdAt);
    expect(originalBody.reversedTransactionId).toBeUndefined();
    expect(await entriesRead(built.app, u.o1, d)).toEqual(
      [
        [a1.id, '5000'],
        [s, '-5000'],
      ].sort(),
    );

    const history = await built.app.inject({
      method: 'GET',
      url: `/v1/accounts/${a1.id}/entries`,
      headers: bearer(u.c1),
    });
    expect(history.statusCode).toBe(200);
    const items = history.json<{ items: { kind: string; amount: string }[] }>().items;
    expect(items.map(({ kind, amount }) => ({ kind, amount }))).toEqual([
      { kind: 'reversal', amount: '-5000' },
      { kind: 'deposit', amount: '5000' },
    ]);
  });

  it('REV-AC02 reversing a withdrawal and a transfer negates their entries, the transfer without touching a system account', async () => {
    const u = users();
    const a1 = await createAccount(built.app, u.c1);
    const b1 = await createAccount(built.app, u.c2);
    idOf(await deposit(built.app, u.o1, a1.id, '5000'));
    const w = idOf(await withdraw(built.app, u.c1, a1.id, '1200'));
    const t = idOf(await transfer(built.app, u.c1, a1.id, b1.id, '300'));
    expect(await balanceOf(a1.id)).toBe('3500');
    expect(await balanceOf(b1.id)).toBe('300');
    const settlementBefore = await settlementSum(s);

    const wReversal = await reverse(built.app, u.o1, w);
    const tReversal = await reverse(built.app, u.o1, t);

    expect(wReversal.statusCode, wReversal.body).toBe(201);
    expect(tReversal.statusCode, tReversal.body).toBe(201);
    const wBody = wReversal.json<MovementJson & { reversedTransactionId: string }>();
    const tBody = tReversal.json<MovementJson & { reversedTransactionId: string }>();
    expect(wBody).toMatchObject({ kind: 'reversal', reversedTransactionId: w });
    expect(tBody).toMatchObject({ kind: 'reversal', reversedTransactionId: t });
    expect(await entriesRead(built.app, u.o1, wBody.id)).toEqual(
      [
        [a1.id, '1200'],
        [s, '-1200'],
      ].sort(),
    );
    expect(await entriesRead(built.app, u.o1, tBody.id)).toEqual(
      [
        [a1.id, '300'],
        [b1.id, '-300'],
      ].sort(),
    );
    expect(await balanceOf(a1.id)).toBe('5000');
    expect(await balanceOf(b1.id)).toBe('0');
    expect((await settlementSum(s)) - settlementBefore).toBe(-1200n);
  });
});
