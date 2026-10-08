import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { closePools } from '../../support/db.js';
import {
  bearer,
  createAccount,
  deposit,
  reverse,
  type MovementJson,
  type TransactionJson,
} from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';

describe('the reversal route', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('REV-R16 a reversal answers 201 with exactly the fields of section 1.3, and neither it nor the read of the reversal returns the reason', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, c1, 'EUR');
    const original = (await deposit(built.app, o1, a1.id, '1000')).json<MovementJson>();
    const reason = `Duplicate deposit from rail ${randomUUID()}`;

    const reversed = await reverse(built.app, o1, original.id.toUpperCase(), { reason });
    expect(reversed.statusCode).toBe(201);
    expect(reversed.headers['content-type']).toMatch(/^application\/json/);
    const body = reversed.json<MovementJson & { reversedTransactionId: string }>();
    expect(Object.keys(body)).toEqual([
      'id',
      'kind',
      'amount',
      'currency',
      'createdAt',
      'reversedTransactionId',
    ]);
    expect(body).toMatchObject({
      kind: 'reversal',
      amount: '1000',
      currency: 'EUR',
      reversedTransactionId: original.id,
    });
    expect(body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(reversed.headers.location).toBe(`/v1/transactions/${body.id}`);
    expect(reversed.body).not.toContain(reason);

    const read = await built.app.inject({
      method: 'GET',
      url: `/v1/transactions/${body.id}`,
      headers: bearer(c1),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json<TransactionJson>()).toEqual({
      id: body.id,
      kind: 'reversal',
      amount: '1000',
      currency: 'EUR',
      createdAt: body.createdAt,
      reversedTransactionId: original.id,
      entries: [{ accountId: a1.id, amount: '-1000' }],
    });
    expect(read.body).not.toContain(reason);
    expect(built.logs.text()).not.toContain(reason);
  });
});
