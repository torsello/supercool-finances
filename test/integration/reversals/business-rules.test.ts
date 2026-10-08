import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { balanceOf, closePools, runtimePool } from '../../support/db.js';
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
import { footprint, idOf, reversalsOf, users } from './support.js';

const MAX = '9223372036854775807';

async function statusOf(accountId: string): Promise<string | null> {
  const result = await runtimePool().query<{ status: string | null }>(
    'SELECT status FROM accounts WHERE id = $1',
    [accountId],
  );
  return result.rows[0]?.status ?? null;
}

function expectProblem(response: LightMyRequestResponse, status: number, type: string): void {
  expect(response.statusCode, response.body).toBe(status);
  expect(problemOf(response).type).toBe(type);
}

async function expectOk(response: Promise<LightMyRequestResponse>): Promise<void> {
  const answer = await response;
  expect(answer.statusCode, answer.body).toBe(200);
}

describe('the business rules of a reversal', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('REV-AC10 money already spent cannot be reversed until it is back', async () => {
    const u = users();
    const a1 = await createAccount(built.app, u.c1);
    const b1 = await createAccount(built.app, u.c2);
    const d = idOf(await deposit(built.app, u.o1, a1.id, '1000'));
    idOf(await withdraw(built.app, u.c1, a1.id, '600'));
    const t = idOf(await transfer(built.app, u.c1, a1.id, b1.id, '300'));
    idOf(await withdraw(built.app, u.c2, b1.id, '250'));
    expect(await balanceOf(a1.id)).toBe('100');
    expect(await balanceOf(b1.id)).toBe('50');
    const before = await footprint([a1.id, b1.id]);

    expectProblem(
      await reverse(built.app, u.o1, d),
      422,
      '/problems/insufficient-funds-for-reversal',
    );
    expectProblem(
      await reverse(built.app, u.o1, t),
      422,
      '/problems/insufficient-funds-for-reversal',
    );
    expect(await balanceOf(a1.id)).toBe('100');
    expect(await balanceOf(b1.id)).toBe('50');
    expect(await footprint([a1.id, b1.id])).toEqual(before);
    expect(await reversalsOf(d)).toEqual([]);
    expect(await reversalsOf(t)).toEqual([]);

    idOf(await deposit(built.app, u.o1, a1.id, '900'));
    idOf(await deposit(built.app, u.o1, b1.id, '250'));
    expect(await balanceOf(a1.id)).toBe('1000');
    expect(await balanceOf(b1.id)).toBe('300');

    idOf(await reverse(built.app, u.o1, d));
    expect(await balanceOf(a1.id)).toBe('0');
    idOf(await reverse(built.app, u.o1, t));
    expect(await balanceOf(a1.id)).toBe('300');
    expect(await balanceOf(b1.id)).toBe('0');
  });

  it('REV-AC11 frozen accounts can be reversed and stay frozen', async () => {
    const u = users();
    const a1 = await createAccount(built.app, u.c1);
    const b1 = await createAccount(built.app, u.c2);
    const d = idOf(await deposit(built.app, u.o1, a1.id, '1000'));
    const t = idOf(await transfer(built.app, u.c1, a1.id, b1.id, '400'));
    await expectOk(changeStatus(built.app, u.o1, a1.id, 'freeze'));
    await expectOk(changeStatus(built.app, u.o1, b1.id, 'freeze'));

    idOf(await reverse(built.app, u.o1, t));
    expect(await balanceOf(a1.id)).toBe('1000');
    expect(await balanceOf(b1.id)).toBe('0');
    idOf(await reverse(built.app, u.o1, d));
    expect(await balanceOf(a1.id)).toBe('0');
    expect(await statusOf(a1.id)).toBe('frozen');
    expect(await statusOf(b1.id)).toBe('frozen');
  });

  it('REV-AC12 a closed account blocks the reversal of a deposit, a withdrawal and a transfer', async () => {
    const u = users();
    const x1 = await createAccount(built.app, u.c1);
    const a1 = await createAccount(built.app, u.c1);
    const x2 = await createAccount(built.app, u.c2);
    idOf(await deposit(built.app, u.o1, a1.id, '1000'));
    const d = idOf(await deposit(built.app, u.o1, x1.id, '500'));
    const w = idOf(await withdraw(built.app, u.c1, x1.id, '500'));
    const t = idOf(await transfer(built.app, u.c1, a1.id, x2.id, '300'));
    idOf(await withdraw(built.app, u.c2, x2.id, '300'));
    await expectOk(changeStatus(built.app, u.o1, x1.id, 'close'));
    await expectOk(changeStatus(built.app, u.o1, x2.id, 'close'));
    expect(await balanceOf(a1.id)).toBe('700');
    const accounts = [x1.id, x2.id, a1.id];
    const before = await footprint(accounts);

    for (const original of [d, w, t]) {
      expectProblem(await reverse(built.app, u.o1, original), 422, '/problems/account-not-active');
    }

    for (const closed of [x1.id, x2.id]) {
      expect(await statusOf(closed)).toBe('closed');
      expect(await balanceOf(closed)).toBe('0');
    }
    expect(await balanceOf(a1.id)).toBe('700');
    expect(await footprint(accounts)).toEqual(before);
  });

  it('REV-AC24 the checks of a reversal run in a fixed order', async () => {
    const u = users();
    const x1 = await createAccount(built.app, u.c1);
    const x2 = await createAccount(built.app, u.c1);
    const d1 = idOf(await deposit(built.app, u.o1, x1.id, '500'));
    const r1 = idOf(await reverse(built.app, u.o1, d1));
    const d2 = idOf(await deposit(built.app, u.o1, x2.id, '500'));
    idOf(await withdraw(built.app, u.c1, x2.id, '500'));
    await expectOk(changeStatus(built.app, u.o1, x1.id, 'close'));
    await expectOk(changeStatus(built.app, u.o1, x2.id, 'close'));
    const before = await footprint([x1.id, x2.id]);

    expectProblem(
      await reverse(built.app, u.o1, randomUUID(), { reason: 'ab' }),
      422,
      '/problems/validation-error',
    );
    expectProblem(
      await reverse(built.app, u.o1, r1, { reason: 'ab' }),
      422,
      '/problems/validation-error',
    );
    expectProblem(await reverse(built.app, u.o1, r1), 422, '/problems/transaction-not-reversible');
    expectProblem(await reverse(built.app, u.o1, d1), 409, '/problems/already-reversed');
    expectProblem(await reverse(built.app, u.o1, d2), 422, '/problems/account-not-active');
    expect(await footprint([x1.id, x2.id])).toEqual(before);
  });
});

describe('the amount limits and a reversal', () => {
  afterAll(async () => {
    await closePools();
  });

  it('REV-AC13 a reversal that would raise a balance above the maximum answers 422, not 500', async () => {
    const { app } = buildProductionApp({ env: { MAX_AMOUNT_MINOR: MAX } });
    try {
      const u = users();
      const a1 = await createAccount(app, u.c1);
      idOf(await deposit(app, u.o1, a1.id, '100'));
      const w = idOf(await withdraw(app, u.c1, a1.id, '100'));
      idOf(await deposit(app, u.o1, a1.id, MAX));
      const before = await footprint([a1.id]);

      expectProblem(await reverse(app, u.o1, w), 422, '/problems/balance-limit-exceeded');

      expect(await balanceOf(a1.id)).toBe(MAX);
      expect(await reversalsOf(w)).toEqual([]);
      expect(await footprint([a1.id])).toEqual(before);
    } finally {
      await app.close();
    }
  });

  it('REV-AC14 MAX_AMOUNT_MINOR does not limit a reversal after a restart with a lower one', async () => {
    const u = users();
    const first = buildProductionApp();
    let a1Id: string;
    let d: string;
    try {
      const a1 = await createAccount(first.app, u.c1);
      a1Id = a1.id;
      d = idOf(await deposit(first.app, u.o1, a1.id, '1000'));
    } finally {
      await first.app.close();
    }

    const restarted = buildProductionApp({ env: { MAX_AMOUNT_MINOR: '100' } });
    try {
      const response = await reverse(restarted.app, u.o1, d);
      expect(response.statusCode, response.body).toBe(201);
      expect(response.json<MovementJson>().amount).toBe('1000');
      expect(await balanceOf(a1Id)).toBe('0');
    } finally {
      await restarted.app.close();
    }
  });
});
