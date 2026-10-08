import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { closePools, settlementAccountId } from '../../support/db.js';
import {
  bearer,
  createAccount,
  deposit,
  transfer,
  withdraw,
  type MovementJson,
  type TransactionJson,
} from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('the movement routes', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('MOV-R25 a deposit answers 201 with the body of section 1.2 without accountId or balance; a withdrawal and a transfer add only the source and its balance', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const c2 = tokenFor(randomUUID(), 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, c1, 'EUR');
    const b1 = await createAccount(built.app, c2, 'EUR');

    const deposited = await deposit(built.app, o1, a1.id, '1000');
    expect(deposited.statusCode).toBe(201);
    expect(deposited.headers['content-type']).toMatch(/^application\/json/);
    const depositBody = deposited.json<MovementJson>();
    expect(Object.keys(depositBody)).toEqual(['id', 'kind', 'amount', 'currency', 'createdAt']);
    expect(depositBody).toMatchObject({ kind: 'deposit', amount: '1000', currency: 'EUR' });
    expect(depositBody.createdAt).toMatch(TIMESTAMP);
    expect(deposited.headers.location).toBe(`/v1/transactions/${depositBody.id}`);

    const withdrawn = await withdraw(built.app, c1, a1.id.toUpperCase(), '200');
    expect(withdrawn.statusCode).toBe(201);
    const withdrawalBody = withdrawn.json<MovementJson>();
    expect(Object.keys(withdrawalBody)).toEqual([
      'id',
      'kind',
      'amount',
      'currency',
      'createdAt',
      'accountId',
      'balance',
    ]);
    expect(withdrawalBody).toMatchObject({
      kind: 'withdrawal',
      amount: '200',
      currency: 'EUR',
      accountId: a1.id,
      balance: '800',
    });
    expect(withdrawn.headers.location).toBe(`/v1/transactions/${withdrawalBody.id}`);

    const transferred = await transfer(built.app, c1, a1.id, b1.id, '300');
    expect(transferred.statusCode).toBe(201);
    expect(transferred.json<MovementJson>()).toMatchObject({
      kind: 'transfer',
      amount: '300',
      accountId: a1.id,
      balance: '500',
    });
    expect(transferred.json<MovementJson>()).not.toHaveProperty('destinationAccountId');
  });

  it('MOV-R26 MOV-R27 a transaction is read with the representation of section 1.3: every entry for an operator, only the own entries for a customer', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const c2 = tokenFor(randomUUID(), 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, c1, 'EUR');
    const b1 = await createAccount(built.app, c2, 'EUR');
    const deposited = (await deposit(built.app, o1, a1.id, '1000')).json<MovementJson>();
    const transferred = (await transfer(built.app, c1, a1.id, b1.id, '300')).json<MovementJson>();

    const read = (token: string, id: string) =>
      built.app.inject({ method: 'GET', url: `/v1/transactions/${id}`, headers: bearer(token) });

    const asOperator = await read(o1, deposited.id);
    expect(asOperator.statusCode).toBe(200);
    expect(asOperator.json<TransactionJson>()).toEqual({
      id: deposited.id,
      kind: 'deposit',
      amount: '1000',
      currency: 'EUR',
      createdAt: deposited.createdAt,
      entries: [
        { accountId: a1.id, amount: '1000' },
        { accountId: await settlementAccountId('EUR'), amount: '-1000' },
      ],
    });

    const asReceiver = await read(c2, transferred.id.toUpperCase());
    expect(asReceiver.statusCode).toBe(200);
    expect(asReceiver.json<TransactionJson>()).toEqual({
      id: transferred.id,
      kind: 'transfer',
      amount: '300',
      currency: 'EUR',
      createdAt: transferred.createdAt,
      entries: [{ accountId: b1.id, amount: '300' }],
    });

    const notVisible = await read(c2, deposited.id);
    expect(notVisible.statusCode).toBe(404);
  });
});
