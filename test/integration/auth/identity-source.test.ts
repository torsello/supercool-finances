import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { balanceOf, closePools, runtimePool } from '../../support/db.js';
import {
  bearer,
  createAccount,
  deposit,
  freshKey,
  problemOf,
  type AccountJson,
} from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';

async function accountsOwnedBy(ownerId: string): Promise<string[]> {
  const result = await runtimePool().query<{ id: string }>(
    'SELECT id FROM accounts WHERE owner_id = $1 ORDER BY id',
    [ownerId],
  );
  return result.rows.map((row) => row.id);
}

describe('the source of the caller’s identity', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('AUT-AC11 takes the user id and role only from the token, never from a body, query string or header', async () => {
    const c1Id = randomUUID();
    const c2Id = randomUUID();
    const c1 = tokenFor(c1Id, 'customer');
    const c2 = tokenFor(c2Id, 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, c1);
    const b1 = await createAccount(built.app, c2);
    for (const account of [a1, b1]) {
      expect((await deposit(built.app, o1, account.id, '1000')).statusCode).toBe(201);
    }

    const creation = await built.app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: bearer(c1),
      payload: { currency: 'EUR', ownerId: c2Id },
    });
    expect(creation.statusCode).toBe(422);
    const creationProblem = problemOf(creation);
    expect(creationProblem.type).toBe('/problems/validation-error');
    expect(creationProblem['errors']).toEqual([
      { pointer: '/ownerId', detail: expect.any(String) as unknown },
    ]);
    expect(await accountsOwnedBy(c1Id)).toEqual([a1.id]);
    expect(await accountsOwnedBy(c2Id)).toEqual([b1.id]);

    const withdrawal = await built.app.inject({
      method: 'POST',
      url: `/v1/accounts/${a1.id}/withdrawals`,
      headers: { ...bearer(c1), 'idempotency-key': freshKey() },
      payload: { amount: '100', currency: 'EUR', userId: c2Id },
    });
    expect(withdrawal.statusCode).toBe(422);
    const withdrawalProblem = problemOf(withdrawal);
    expect(withdrawalProblem.type).toBe('/problems/validation-error');
    expect(withdrawalProblem['errors']).toEqual([
      { pointer: '/userId', detail: expect.any(String) as unknown },
    ]);

    const listByOwner = await built.app.inject({
      method: 'GET',
      url: `/v1/accounts?ownerId=${c2Id}`,
      headers: bearer(c1),
    });
    expect(listByOwner.statusCode).toBe(422);
    const listProblem = problemOf(listByOwner);
    expect(listProblem.type).toBe('/problems/validation-error');
    expect(listProblem['errors']).toEqual([
      { parameter: 'ownerId', detail: expect.any(String) as unknown },
    ]);

    const readB1 = await built.app.inject({
      method: 'GET',
      url: `/v1/accounts/${b1.id}`,
      headers: { ...bearer(c1), 'x-user-id': c2Id },
    });
    expect(readB1.statusCode).toBe(404);
    expect(problemOf(readB1).type).toBe('/problems/not-found');

    const listWithHeader = await built.app.inject({
      method: 'GET',
      url: '/v1/accounts',
      headers: { ...bearer(c1), 'x-user-id': c2Id },
    });
    expect(listWithHeader.statusCode).toBe(200);
    expect(
      listWithHeader.json<{ items: AccountJson[] }>().items.map((account) => account.id),
    ).toEqual([a1.id]);

    const depositAsOperator = await built.app.inject({
      method: 'POST',
      url: `/v1/accounts/${a1.id}/deposits`,
      headers: { ...bearer(c1), 'idempotency-key': freshKey() },
      payload: { amount: '100', currency: 'EUR', role: 'operator' },
    });
    expect(depositAsOperator.statusCode).toBe(403);
    expect(problemOf(depositAsOperator).type).toBe('/problems/forbidden');

    expect(await balanceOf(a1.id)).toBe('1000');
    expect(await balanceOf(b1.id)).toBe('1000');
  });
});
