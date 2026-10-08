import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { closePools } from '../../support/db.js';
import { bearer, createAccount, deposit, freshKey, problemOf } from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';
import { writtenRows } from '../movements/support.js';

describe('the validation step', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('SYS-R27 answers the errors of the body and of the query string together in one 422, body entries first, on every route that takes both', async () => {
    const customer = tokenFor(randomUUID(), 'customer');
    const operator = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, customer, 'EUR');
    const b1 = await createAccount(built.app, tokenFor(randomUUID(), 'customer'), 'EUR');
    const original = await deposit(built.app, operator, a1.id, '1000');
    const transactionId = original.json<{ id: string }>().id;
    const before = await writtenRows();

    const cases = [
      { url: '/v1/accounts', token: customer, body: { currency: 'GBP' }, pointer: '/currency' },
      {
        url: '/v1/accounts',
        token: customer,
        body: { currency: 'GBP' },
        pointer: '/currency',
        key: true,
      },
      { url: `/v1/accounts/${a1.id}/freeze`, token: operator, body: { a: 1 }, pointer: '/a' },
      {
        url: `/v1/accounts/${a1.id}/deposits`,
        token: operator,
        body: { amount: '0', currency: 'EUR' },
        pointer: '/amount',
        key: true,
      },
      {
        url: `/v1/accounts/${a1.id}/withdrawals`,
        token: customer,
        body: { amount: '0', currency: 'EUR' },
        pointer: '/amount',
        key: true,
      },
      // The registered schema passes; the second check, with the path's source, refuses.
      {
        url: `/v1/accounts/${a1.id}/transfers`,
        token: customer,
        body: { destinationAccountId: a1.id.toUpperCase(), amount: '1', currency: 'EUR' },
        pointer: '/destinationAccountId',
        key: true,
      },
      {
        url: `/v1/accounts/${a1.id}/transfers`,
        token: customer,
        body: { destinationAccountId: b1.id, amount: '0', currency: 'EUR' },
        pointer: '/amount',
        key: true,
      },
      {
        url: `/v1/transactions/${transactionId}/reversals`,
        token: operator,
        body: { reason: 'ab' },
        pointer: '/reason',
        key: true,
      },
    ];
    for (const { url, token, body, pointer, key } of cases) {
      const response = await built.app.inject({
        method: 'POST',
        url: `${url}?x=1&limit=5`,
        headers: { ...bearer(token), ...(key === true ? { 'idempotency-key': freshKey() } : {}) },
        payload: body,
      });
      expect(response.statusCode, url).toBe(422);
      const problem = problemOf(response);
      expect(problem.type).toBe('/problems/validation-error');
      expect(problem['errors'], url).toEqual([
        { pointer, detail: expect.any(String) as string },
        { parameter: 'x', detail: 'Unknown parameter.' },
        { parameter: 'limit', detail: 'Unknown parameter.' },
      ]);
    }

    // A valid body with an unknown parameter still answers the parameter alone.
    const queryOnly = await built.app.inject({
      method: 'POST',
      url: `/v1/accounts/${a1.id}/withdrawals?x=1`,
      headers: { ...bearer(customer), 'idempotency-key': freshKey() },
      payload: { amount: '1', currency: 'EUR' },
    });
    expect(queryOnly.statusCode).toBe(422);
    expect(problemOf(queryOnly)['errors']).toEqual([
      { parameter: 'x', detail: 'Unknown parameter.' },
    ]);
    expect(await writtenRows()).toEqual(before);
  });
});
