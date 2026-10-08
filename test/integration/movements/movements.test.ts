import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { balanceOf, closePools, settlementAccountId } from '../../support/db.js';
import {
  createAccount,
  deposit,
  transfer,
  withdraw,
  type MovementJson,
} from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';
import { entriesOf } from './support.js';

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('deposits, withdrawals and transfers', () => {
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

  it('MOV-AC01 an operator deposit answers 201 with its Location and body without balance, and appends +A on the account and -A on the settlement account', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, c1, 'EUR');

    const response = await deposit(built.app, o1, a1.id, '5000');

    expect(response.statusCode).toBe(201);
    const body = response.json<MovementJson>();
    expect(response.headers.location).toBe(`/v1/transactions/${body.id}`);
    expect(Object.keys(body).sort()).toEqual(['amount', 'createdAt', 'currency', 'id', 'kind']);
    expect(body).toEqual({
      id: body.id,
      kind: 'deposit',
      amount: '5000',
      currency: 'EUR',
      createdAt: expect.stringMatching(TIMESTAMP) as unknown,
    });
    expect(body).not.toHaveProperty('balance');
    expect(await balanceOf(a1.id)).toBe('5000');
    expect(await entriesOf(body.id)).toEqual([
      [a1.id, '5000'],
      [s, '-5000'],
    ]);
  });

  it('MOV-AC02 a withdrawal answers 201 with the account and its new balance, and the whole balance can be withdrawn', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, c1, 'EUR');
    expect((await deposit(built.app, o1, a1.id, '5000')).statusCode).toBe(201);

    const first = await withdraw(built.app, c1, a1.id, '1200');

    expect(first.statusCode).toBe(201);
    const body = first.json<MovementJson>();
    expect(first.headers.location).toBe(`/v1/transactions/${body.id}`);
    expect(Object.keys(body).sort()).toEqual([
      'accountId',
      'amount',
      'balance',
      'createdAt',
      'currency',
      'id',
      'kind',
    ]);
    expect(body).toEqual({
      id: body.id,
      kind: 'withdrawal',
      amount: '1200',
      currency: 'EUR',
      createdAt: expect.stringMatching(TIMESTAMP) as unknown,
      accountId: a1.id,
      balance: '3800',
    });
    expect(await entriesOf(body.id)).toEqual([
      [a1.id, '-1200'],
      [s, '1200'],
    ]);

    const second = await withdraw(built.app, c1, a1.id, '3800');
    expect(second.statusCode).toBe(201);
    expect(second.json<MovementJson>().balance).toBe('0');
    expect(await balanceOf(a1.id)).toBe('0');
  });

  it('MOV-AC03 a transfer to another customer and to an own account answers only the source and its balance, with entries on the two customer accounts only', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const c2 = tokenFor(randomUUID(), 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, c1, 'EUR');
    const a2 = await createAccount(built.app, c1, 'EUR');
    const b1 = await createAccount(built.app, c2, 'EUR');
    expect((await deposit(built.app, o1, a1.id, '5000')).statusCode).toBe(201);
    expect((await deposit(built.app, o1, a2.id, '50')).statusCode).toBe(201);
    expect((await deposit(built.app, o1, b1.id, '100')).statusCode).toBe(201);

    const toOther = await transfer(built.app, c1, a1.id, b1.id, '300');

    expect(toOther.statusCode).toBe(201);
    const body = toOther.json<MovementJson>();
    expect(body).toEqual({
      id: body.id,
      kind: 'transfer',
      amount: '300',
      currency: 'EUR',
      createdAt: expect.stringMatching(TIMESTAMP) as unknown,
      accountId: a1.id,
      balance: '4700',
    });
    expect(Object.values(body)).not.toContain(b1.id);
    expect(Object.values(body)).not.toContain('400');
    const entries = await entriesOf(body.id);
    expect(entries).toHaveLength(2);
    expect(entries).toEqual(
      expect.arrayContaining([
        [a1.id, '-300'],
        [b1.id, '300'],
      ]),
    );
    expect(entries.map(([account]) => account)).not.toContain(s);

    const toOwn = await transfer(built.app, c1, a1.id, a2.id, '700');
    expect(toOwn.statusCode).toBe(201);
    const ownBody = toOwn.json<MovementJson>();
    // Exactly the members of a transfer answer: the source and its balance, nothing of A2 beyond
    // the amount moved.
    expect(ownBody).toEqual({
      id: ownBody.id,
      kind: 'transfer',
      amount: '700',
      currency: 'EUR',
      createdAt: expect.stringMatching(TIMESTAMP) as unknown,
      accountId: a1.id,
      balance: '4000',
    });
    expect(Object.values(ownBody)).not.toContain('750');

    expect(await balanceOf(a1.id)).toBe('4000');
    expect(await balanceOf(a2.id)).toBe('750');
    expect(await balanceOf(b1.id)).toBe('400');
  });
});
