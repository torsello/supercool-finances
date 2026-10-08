import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { closePools } from '../../support/db.js';
import {
  bearer,
  createAccount,
  deposit,
  problemOf,
  transfer,
  withoutRequestId,
  type MovementJson,
  type TransactionJson,
} from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';

describe('reading a transaction', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  async function read(token: string, id: string): Promise<LightMyRequestResponse> {
    return await built.app.inject({
      method: 'GET',
      url: `/v1/transactions/${id}`,
      headers: bearer(token),
    });
  }

  it('MOV-AC18 an operator reads every entry, each customer only the entries of their own accounts, and anything else is one not-found', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const c2 = tokenFor(randomUUID(), 'customer');
    const c3 = tokenFor(randomUUID(), 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, c1, 'EUR');
    const b1 = await createAccount(built.app, c2, 'EUR');
    await createAccount(built.app, c3, 'EUR');
    const d = (await deposit(built.app, o1, a1.id, '1000')).json<MovementJson>();
    const t = (await transfer(built.app, c1, a1.id, b1.id, '300')).json<MovementJson>();

    const byOperator = await read(o1, t.id);
    expect(byOperator.statusCode).toBe(200);
    const all = byOperator.json<TransactionJson>();
    expect(all).toMatchObject({ id: t.id, kind: 'transfer', amount: '300', currency: 'EUR' });
    expect(all.entries).toHaveLength(2);
    expect(all.entries).toEqual(
      expect.arrayContaining([
        { accountId: a1.id, amount: '-300' },
        { accountId: b1.id, amount: '300' },
      ]),
    );

    const byC1 = await read(c1, t.id);
    expect(byC1.statusCode).toBe(200);
    expect(byC1.json<TransactionJson>().entries).toEqual([{ accountId: a1.id, amount: '-300' }]);

    const byC2 = await read(c2, t.id);
    expect(byC2.statusCode).toBe(200);
    expect(byC2.json<TransactionJson>().entries).toEqual([{ accountId: b1.id, amount: '300' }]);
    expect(byC2.body).not.toContain(a1.id);

    const notFound = [
      await read(c2, d.id),
      await read(c3, t.id),
      await read(c1, randomUUID()),
      await read(c1, 'not-a-uuid'),
    ];
    const bodies = notFound.map((response) => {
      expect(response.statusCode).toBe(404);
      const problem = problemOf(response);
      expect(problem.type).toBe('/problems/not-found');
      return withoutRequestId(problem);
    });
    for (const body of bodies) expect(body).toEqual(bodies[0]);
  });
});
