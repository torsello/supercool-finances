import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { balanceOf, closePools } from '../../support/db.js';
import {
  changeStatus,
  createAccount,
  deposit,
  problemOf,
  reverse,
  transfer,
  withdraw,
  type MovementJson,
} from '../../support/http.js';
import { buildTestApp } from '../../support/test-app.js';
import { tokenFor } from '../../support/tokens.js';
import { auditsOn, keyRowOf, reversalsOf, transactionsOn } from './support.js';

/** Asserts that a retry answered the stored status and bytes of the first answer, as a replay. */
function expectReplayOf(retry: LightMyRequestResponse, first: LightMyRequestResponse, name = '') {
  expect(retry.statusCode, name).toBe(first.statusCode);
  expect(retry.headers['content-type'], name).toBe(first.headers['content-type']);
  expect(retry.rawPayload.equals(first.rawPayload), name).toBe(true);
  expect(retry.headers['idempotent-replayed'], name).toBe('true');
}

describe('stored rejections', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('IDM-AC15 a business rejection is stored with its requestId and replayed after the funds arrive', async () => {
    const c1 = randomUUID();
    const c1Token = tokenFor(c1, 'customer');
    const o1Token = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, c1Token, 'EUR');
    await deposit(built.app, o1Token, a1.id, '1000');
    const auditsBefore = await auditsOn(a1.id);
    const send = () =>
      built.app.inject({
        method: 'POST',
        url: `/v1/accounts/${a1.id}/withdrawals`,
        headers: {
          authorization: `Bearer ${c1Token}`,
          'idempotency-key': 'k1',
          'x-request-id': 'r1',
        },
        payload: { amount: '1500', currency: 'EUR' },
      });

    const first = await send();
    expect(first.statusCode).toBe(422);
    const problem = problemOf(first);
    expect(problem.type).toBe('/problems/insufficient-funds');
    expect(problem.requestId).toBe('r1');
    const stored = await keyRowOf(c1, 'k1');
    expect(stored?.status).toBe(422);
    expect(stored?.body?.equals(first.rawPayload)).toBe(true);
    expect(await transactionsOn(a1.id)).toEqual({ deposit: 1 });
    expect(await auditsOn(a1.id)).toEqual(auditsBefore);

    expect((await deposit(built.app, o1Token, a1.id, '1000')).statusCode).toBe(201);

    const retry = await send();
    expectReplayOf(retry, first);
    expect(problemOf(retry).requestId).toBe('r1');
    expect(await balanceOf(a1.id)).toBe('2000');
    expect((await transactionsOn(a1.id))['withdrawal']).toBeUndefined();
  });

  it('IDM-AC16 lookup and business rejections are stored and replayed, also after the account state changed', async () => {
    const c1Token = tokenFor(randomUUID(), 'customer');
    const c2Token = tokenFor(randomUUID(), 'customer');
    const o1Token = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, c1Token, 'EUR');
    const f1 = await createAccount(built.app, c1Token, 'EUR');
    const x2 = await createAccount(built.app, c2Token, 'EUR');
    const d = (await deposit(built.app, o1Token, a1.id, '1000')).json<MovementJson>();
    await deposit(built.app, o1Token, f1.id, '1000');
    expect((await changeStatus(built.app, o1Token, f1.id, 'freeze')).statusCode).toBe(200);
    expect((await changeStatus(built.app, o1Token, x2.id, 'close')).statusCode).toBe(200);
    const u = randomUUID();

    const requests: [string, () => Promise<LightMyRequestResponse>, number, string][] = [
      [
        'k1',
        () => withdraw(built.app, c1Token, u, '100', { key: 'k1' }),
        404,
        '/problems/not-found',
      ],
      [
        'k2',
        () => withdraw(built.app, c1Token, a1.id, '100', { key: 'k2', currency: 'USD' }),
        422,
        '/problems/currency-mismatch',
      ],
      [
        'k3',
        () => withdraw(built.app, c1Token, f1.id, '100', { key: 'k3' }),
        422,
        '/problems/account-not-active',
      ],
      [
        'k4',
        () => transfer(built.app, c1Token, a1.id, x2.id, '100', { key: 'k4' }),
        422,
        '/problems/destination-unavailable',
      ],
      ['k5', () => reverse(built.app, o1Token, d.id, { key: 'k5' }), 201, ''],
      [
        'k6',
        () => reverse(built.app, o1Token, d.id, { key: 'k6' }),
        409,
        '/problems/already-reversed',
      ],
    ];
    const firsts: LightMyRequestResponse[] = [];
    for (const [key, send, status, type] of requests) {
      const response = await send();
      expect(response.statusCode, key).toBe(status);
      if (type !== '') expect(problemOf(response).type, key).toBe(type);
      firsts.push(response);
    }

    expect((await changeStatus(built.app, o1Token, f1.id, 'unfreeze')).statusCode).toBe(200);

    for (const [index, [key, send]] of requests.entries()) {
      const first = firsts[index];
      if (first === undefined) throw new Error(`no first answer for ${key}`);
      expectReplayOf(await send(), first, key);
    }

    expect(await reversalsOf(d.id)).toHaveLength(1);
    expect(await transactionsOn(a1.id)).toEqual({ deposit: 1, reversal: 1 });
    expect(await transactionsOn(f1.id)).toEqual({ deposit: 1 });
    expect(await transactionsOn(x2.id)).toEqual({});
    expect(await balanceOf(a1.id)).toBe('0');
    expect(await balanceOf(f1.id)).toBe('1000');
    expect(await balanceOf(x2.id)).toBe('0');
  });

  it('IDM-AC17 a second reversal refused by the unique constraint answers 409 already-reversed, is stored and is replayed', async () => {
    const o1 = randomUUID();
    const o1Token = tokenFor(o1, 'operator');
    const testApp = buildTestApp();
    try {
      await testApp.app.ready();
      const a1 = await createAccount(testApp.app, tokenFor(randomUUID(), 'customer'), 'EUR');
      const d = (await deposit(testApp.app, o1Token, a1.id, '1000')).json<MovementJson>();
      await deposit(testApp.app, o1Token, a1.id, '1000');
      expect((await reverse(testApp.app, o1Token, d.id)).statusCode).toBe(201);
      expect(await balanceOf(a1.id)).toBe('1000');

      testApp.reversalCheck.enable();
      const first = await reverse(testApp.app, o1Token, d.id, { key: 'k2' });
      expect(testApp.reversalCheck.skipped).toEqual([d.id]);
      expect(testApp.reversalCheck.refused).toEqual([
        { sqlstate: '23505', constraint: 'transactions_reversed_transaction_id_key' },
      ]);
      expect(first.statusCode).toBe(409);
      expect(problemOf(first).type).toBe('/problems/already-reversed');
      const stored = await keyRowOf(o1, 'k2');
      expect(stored?.status).toBe(409);
      expect(stored?.body?.equals(first.rawPayload)).toBe(true);

      expectReplayOf(await reverse(testApp.app, o1Token, d.id, { key: 'k2' }), first);
      expect(await balanceOf(a1.id)).toBe('1000');
      expect(await reversalsOf(d.id)).toHaveLength(1);
    } finally {
      testApp.reversalCheck.disable();
      await testApp.app.close();
    }
  });
});
