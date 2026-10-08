import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { balanceOf, closePools, runtimePool } from '../../support/db.js';
import {
  bearer,
  changeStatus,
  createAccount,
  deposit,
  problemOf,
  transfer,
  withdraw,
  withoutRequestId,
  type AccountJson,
  type MovementJson,
} from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';

async function entryCount(accountIds: string[]): Promise<number> {
  const result = await runtimePool().query<{ count: string }>(
    'SELECT count(*) FROM ledger_entries WHERE account_id = ANY ($1::uuid[])',
    [accountIds],
  );
  return Number(result.rows[0]?.count ?? 'NaN');
}

describe('accounts of other customers', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  async function funded(owner: string, operator: string, amount: string): Promise<AccountJson> {
    const account = await createAccount(built.app, owner);
    if (amount !== '0') {
      expect((await deposit(built.app, operator, account.id, amount)).statusCode).toBe(201);
    }
    return account;
  }

  it('AUT-AC09 answers a customer the same 404 for another customer’s account as for an unknown one', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const c2 = tokenFor(randomUUID(), 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await funded(c1, o1, '1000');
    const b1 = await funded(c2, o1, '5000');
    const u = randomUUID();
    const entriesBefore = await entryCount([a1.id, b1.id]);

    const requests = async (id: string): Promise<[string, LightMyRequestResponse][]> => [
      [
        'read',
        await built.app.inject({ method: 'GET', url: `/v1/accounts/${id}`, headers: bearer(c1) }),
      ],
      [
        'history',
        await built.app.inject({
          method: 'GET',
          url: `/v1/accounts/${id}/entries`,
          headers: bearer(c1),
        }),
      ],
      ['withdraw', await withdraw(built.app, c1, id, '100')],
      ['transfer', await transfer(built.app, c1, id, a1.id, '100')],
    ];
    const onB1 = await requests(b1.id);
    const onU = await requests(u);

    for (const [index, [name, response]] of onB1.entries()) {
      const unknown = onU[index]?.[1];
      if (unknown === undefined) throw new Error(`no request on U for ${name}`);
      for (const answer of [response, unknown]) {
        expect(answer.statusCode, name).toBe(404);
        expect(problemOf(answer).type, name).toBe('/problems/not-found');
      }
      expect(withoutRequestId(problemOf(response)), name).toEqual(
        withoutRequestId(problemOf(unknown)),
      );
    }
    expect(await balanceOf(b1.id)).toBe('5000');
    expect(await balanceOf(a1.id)).toBe('1000');
    expect(await entryCount([a1.id, b1.id])).toBe(entriesBefore);
  });

  it('AUT-AC10 lets a transfer go to another customer’s account, and answers one 422 for a frozen or unknown destination', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const c2 = tokenFor(randomUUID(), 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await funded(c1, o1, '1000');
    const b1 = await funded(c2, o1, '0');
    const f2 = await funded(c2, o1, '0');
    expect((await changeStatus(built.app, o1, f2.id, 'freeze')).statusCode).toBe(200);

    const toB1 = await transfer(built.app, c1, a1.id, b1.id, '300');
    expect(toB1.statusCode).toBe(201);
    const body = toB1.json<MovementJson>();
    expect(body.accountId).toBe(a1.id);
    expect(body.balance).toBe('700');
    expect(Object.keys(body).sort()).toEqual(
      ['id', 'kind', 'amount', 'currency', 'createdAt', 'accountId', 'balance'].sort(),
    );
    expect(await balanceOf(b1.id)).toBe('300');

    const toF2 = await transfer(built.app, c1, a1.id, f2.id, '100');
    const toU = await transfer(built.app, c1, a1.id, randomUUID(), '100');
    for (const response of [toF2, toU]) {
      expect(response.statusCode).toBe(422);
      expect(problemOf(response).type).toBe('/problems/destination-unavailable');
    }
    expect(withoutRequestId(problemOf(toF2))).toEqual(withoutRequestId(problemOf(toU)));
    expect(await balanceOf(a1.id)).toBe('700');
  });
});
