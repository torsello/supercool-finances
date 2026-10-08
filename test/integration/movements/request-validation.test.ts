import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { balanceOf, closePools } from '../../support/db.js';
import {
  bearer,
  createAccount,
  deposit,
  freshKey,
  problemOf,
  type AccountJson,
} from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';
import { transactionsOn } from './support.js';

type Movement = 'deposits' | 'withdrawals' | 'transfers';

describe('movement request validation', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  /** A movement request with the given headers and raw body members. */
  async function post(
    token: string,
    accountId: string,
    movement: Movement,
    payload: Record<string, unknown>,
    key: string | null = freshKey(),
  ): Promise<LightMyRequestResponse> {
    return await built.app.inject({
      method: 'POST',
      url: `/v1/accounts/${accountId}/${movement}`,
      headers: { ...bearer(token), ...(key === null ? {} : { 'idempotency-key': key }) },
      payload,
    });
  }

  /** C1 with A1 at "1000" EUR, C2 with B1 at "0" EUR, and O1. */
  async function given(): Promise<{
    c1: string;
    o1: string;
    a1: AccountJson;
    b1: AccountJson;
  }> {
    const c1 = tokenFor(randomUUID(), 'customer');
    const c2 = tokenFor(randomUUID(), 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, c1, 'EUR');
    const b1 = await createAccount(built.app, c2, 'EUR');
    expect((await deposit(built.app, o1, a1.id, '1000')).statusCode).toBe(201);
    return { c1, o1, a1, b1 };
  }

  function expectValidationError(response: LightMyRequestResponse, pointer: string): void {
    expect(response.statusCode).toBe(422);
    const problem = problemOf(response);
    expect(problem.type).toBe('/problems/validation-error');
    expect(problem['errors']).toEqual([{ pointer, detail: expect.any(String) as unknown }]);
  }

  it('MOV-AC05 a deposit, withdrawal or transfer without an Idempotency-Key, or with an empty one, answers 400 malformed-request', async () => {
    const { c1, o1, a1, b1 } = await given();
    const before = await transactionsOn(a1.id, b1.id);

    for (const key of [null, '']) {
      const responses = [
        await post(o1, a1.id, 'deposits', { amount: '100', currency: 'EUR' }, key),
        await post(c1, a1.id, 'withdrawals', { amount: '100', currency: 'EUR' }, key),
        await post(
          c1,
          a1.id,
          'transfers',
          { destinationAccountId: b1.id, amount: '100', currency: 'EUR' },
          key,
        ),
      ];
      for (const response of responses) {
        expect(response.statusCode, `key ${String(key)}`).toBe(400);
        expect(problemOf(response).type).toBe('/problems/malformed-request');
      }
    }

    expect(await balanceOf(a1.id)).toBe('1000');
    expect(await balanceOf(b1.id)).toBe('0');
    expect(await transactionsOn(a1.id, b1.id)).toBe(before);
  });

  it('MOV-AC06 every invalid or missing amount answers 422 with one errors entry for /amount, on all three movements', async () => {
    const { c1, o1, a1, b1 } = await given();
    const before = await transactionsOn(a1.id, b1.id);
    const amounts: { amount?: unknown }[] = [
      { amount: '0' },
      { amount: '-100' },
      { amount: 'abc' },
      { amount: '10.50' },
      { amount: '0100' },
      { amount: '100000000001' },
      { amount: 100 },
      {},
    ];

    let count = 0;
    for (const amount of amounts) {
      const responses = [
        await post(o1, a1.id, 'deposits', { ...amount, currency: 'EUR' }),
        await post(c1, a1.id, 'withdrawals', { ...amount, currency: 'EUR' }),
        await post(c1, a1.id, 'transfers', {
          destinationAccountId: b1.id,
          ...amount,
          currency: 'EUR',
        }),
      ];
      for (const response of responses) {
        expectValidationError(response, '/amount');
        count += 1;
      }
    }
    expect(count).toBe(24);

    expect(await balanceOf(a1.id)).toBe('1000');
    expect(await balanceOf(b1.id)).toBe('0');
    expect(await transactionsOn(a1.id, b1.id)).toBe(before);
  });

  it('MOV-AC07 a missing or unsupported currency is a validation error, and a currency other than the account’s is a currency mismatch', async () => {
    const { c1, o1, a1, b1 } = await given();
    const j1 = await createAccount(built.app, c1, 'JPY');
    const before = await transactionsOn(a1.id, b1.id, j1.id);

    expectValidationError(await post(c1, a1.id, 'withdrawals', { amount: '100' }), '/currency');
    expectValidationError(
      await post(c1, a1.id, 'withdrawals', { amount: '100', currency: 'GBP' }),
      '/currency',
    );

    const mismatches = [
      await post(o1, a1.id, 'deposits', { amount: '100', currency: 'USD' }),
      await post(c1, a1.id, 'withdrawals', { amount: '100', currency: 'USD' }),
      await post(c1, a1.id, 'transfers', {
        destinationAccountId: b1.id,
        amount: '100',
        currency: 'USD',
      }),
      await post(c1, a1.id, 'transfers', {
        destinationAccountId: j1.id,
        amount: '100',
        currency: 'EUR',
      }),
    ];
    for (const response of mismatches) {
      expect(response.statusCode).toBe(422);
      expect(problemOf(response).type).toBe('/problems/currency-mismatch');
    }

    expect(await balanceOf(a1.id)).toBe('1000');
    expect(await balanceOf(j1.id)).toBe('0');
    expect(await balanceOf(b1.id)).toBe('0');
    expect(await transactionsOn(a1.id, b1.id, j1.id)).toBe(before);
  });

  it('MOV-AC08 a destination equal to the source in any letter case, not a UUID, not a string or missing is a validation error for destinationAccountId', async () => {
    const { c1, a1 } = await given();
    const before = await transactionsOn(a1.id);
    const destinations: { destinationAccountId?: unknown }[] = [
      { destinationAccountId: a1.id },
      { destinationAccountId: a1.id.toUpperCase() },
      { destinationAccountId: 'not-a-uuid' },
      { destinationAccountId: 7 },
      {},
    ];

    for (const destination of destinations) {
      expectValidationError(
        await post(c1, a1.id, 'transfers', { ...destination, amount: '100', currency: 'EUR' }),
        '/destinationAccountId',
      );
    }

    expect(await balanceOf(a1.id)).toBe('1000');
    expect(await transactionsOn(a1.id)).toBe(before);
  });
});
