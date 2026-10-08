import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { balanceOf, closePools, settlementAccountId } from '../../support/db.js';
import {
  bearer,
  changeStatus,
  createAccount,
  deposit,
  freshKey,
  problemOf,
  transfer,
  withdraw,
  withoutRequestId,
} from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';
import { auditsWithRequestId, entriesOn, transactionsOn } from './support.js';

const MAX = '9223372036854775807';

describe('movement business rules', () => {
  let built: BuiltApp;
  let unlimited: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    unlimited = buildProductionApp({ env: { MAX_AMOUNT_MINOR: MAX } });
    await Promise.all([built.app.ready(), unlimited.app.ready()]);
  });

  afterAll(async () => {
    await Promise.all([built.app.close(), unlimited.app.close()]);
    await closePools();
  });

  function expectProblem(response: LightMyRequestResponse, status: number, type: string): void {
    expect(response.statusCode).toBe(status);
    expect(problemOf(response).type).toBe(type);
  }

  it('MOV-AC09 a frozen or closed account can neither receive nor send money, as path account or as own destination', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const f1 = await createAccount(built.app, c1, 'EUR');
    const x1 = await createAccount(built.app, c1, 'EUR');
    const a1 = await createAccount(built.app, c1, 'EUR');
    expect((await deposit(built.app, o1, f1.id, '5000')).statusCode).toBe(201);
    expect((await deposit(built.app, o1, a1.id, '1000')).statusCode).toBe(201);
    expect((await changeStatus(built.app, o1, f1.id, 'freeze')).statusCode).toBe(200);
    expect((await changeStatus(built.app, o1, x1.id, 'close')).statusCode).toBe(200);
    const before = await transactionsOn(f1.id, x1.id, a1.id);

    const responses = [
      await deposit(built.app, o1, f1.id, '100'),
      await deposit(built.app, o1, x1.id, '100'),
      await withdraw(built.app, c1, f1.id, '100'),
      await withdraw(built.app, c1, x1.id, '100'),
      await transfer(built.app, c1, f1.id, a1.id, '100'),
      await transfer(built.app, c1, x1.id, a1.id, '100'),
      await transfer(built.app, c1, a1.id, f1.id, '100'),
      await transfer(built.app, c1, a1.id, x1.id, '100'),
    ];
    for (const response of responses) {
      expectProblem(response, 422, '/problems/account-not-active');
    }

    expect(await balanceOf(f1.id)).toBe('5000');
    expect(await balanceOf(x1.id)).toBe('0');
    expect(await balanceOf(a1.id)).toBe('1000');
    expect(await transactionsOn(f1.id, x1.id, a1.id)).toBe(before);
  });

  it('MOV-AC10 every unavailable destination gets one destination-unavailable body, and insufficient funds come before any destination check', async () => {
    const app = unlimited.app;
    const c1 = tokenFor(randomUUID(), 'customer');
    const c2 = tokenFor(randomUUID(), 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(app, c1, 'EUR');
    const p1 = await createAccount(app, c1, 'EUR');
    const m1 = await createAccount(app, c1, 'EUR');
    const f2 = await createAccount(app, c2, 'EUR');
    const x2 = await createAccount(app, c2, 'EUR');
    const d2 = await createAccount(app, c2, 'USD');
    const m2 = await createAccount(app, c2, 'EUR');
    for (const [account, amount] of [
      [a1.id, '10000'],
      [p1.id, '50'],
      [m1.id, MAX],
      [m2.id, MAX],
    ] as const) {
      expect((await deposit(app, o1, account, amount)).statusCode).toBe(201);
    }
    expect((await changeStatus(app, o1, f2.id, 'freeze')).statusCode).toBe(200);
    expect((await changeStatus(app, o1, x2.id, 'close')).statusCode).toBe(200);
    const s = await settlementAccountId('EUR');
    const u = randomUUID();
    const destinations = [u, s, f2.id, x2.id, d2.id, m2.id, m1.id];
    const customerAccounts = [a1, p1, m1, f2, x2, d2, m2].map((account) => account.id);
    const balancesBefore = await Promise.all(customerAccounts.map(balanceOf));
    const before = await transactionsOn(...customerAccounts);

    const unavailable: LightMyRequestResponse[] = [];
    for (const destination of destinations) {
      unavailable.push(await transfer(app, c1, a1.id, destination, '100'));
    }
    const insufficient: LightMyRequestResponse[] = [];
    for (const destination of destinations) {
      insufficient.push(await transfer(app, c1, p1.id, destination, '100'));
    }

    for (const [answers, type] of [
      [unavailable, '/problems/destination-unavailable'],
      [insufficient, '/problems/insufficient-funds'],
    ] as const) {
      for (const response of answers) expectProblem(response, 422, type);
      const bodies = answers.map((response) => withoutRequestId(problemOf(response)));
      for (const body of bodies) expect(body).toEqual(bodies[0]);
    }

    expect(await Promise.all(customerAccounts.map(balanceOf))).toEqual(balancesBefore);
    expect(await transactionsOn(...customerAccounts)).toBe(before);
  });

  it('MOV-AC11 a withdrawal or transfer above the balance answers insufficient-funds and writes no transaction, entry or audit record', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const c2 = tokenFor(randomUUID(), 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, c1, 'EUR');
    const b1 = await createAccount(built.app, c2, 'EUR');
    expect((await deposit(built.app, o1, a1.id, '1000')).statusCode).toBe(201);
    const transactionsBefore = await transactionsOn(a1.id, b1.id);
    const entriesBefore = await entriesOn(a1.id, b1.id);
    const if1 = 'req-if1';
    const if2 = 'req-if2';

    const withdrawal = await built.app.inject({
      method: 'POST',
      url: `/v1/accounts/${a1.id}/withdrawals`,
      headers: { ...bearer(c1), 'idempotency-key': freshKey(), 'x-request-id': if1 },
      payload: { amount: '1001', currency: 'EUR' },
    });
    const transferred = await built.app.inject({
      method: 'POST',
      url: `/v1/accounts/${a1.id}/transfers`,
      headers: { ...bearer(c1), 'idempotency-key': freshKey(), 'x-request-id': if2 },
      payload: { destinationAccountId: b1.id, amount: '1001', currency: 'EUR' },
    });

    for (const [response, requestId] of [
      [withdrawal, if1],
      [transferred, if2],
    ] as const) {
      expectProblem(response, 422, '/problems/insufficient-funds');
      expect(problemOf(response).requestId).toBe(requestId);
      expect(await auditsWithRequestId(requestId)).toEqual([]);
    }
    expect(await balanceOf(a1.id)).toBe('1000');
    expect(await balanceOf(b1.id)).toBe('0');
    expect(await transactionsOn(a1.id, b1.id)).toBe(transactionsBefore);
    expect(await entriesOn(a1.id, b1.id)).toBe(entriesBefore);
  });
});
