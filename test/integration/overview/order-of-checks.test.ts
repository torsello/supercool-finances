import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import {
  bearer,
  changeStatus,
  createAccount,
  deposit,
  freshKey,
  problemOf,
  type AccountJson,
} from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';

describe('the order of checks (SYS-R31)', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
  });

  it('SYS-AC23 answers each deposit at the first check it fails, in the fixed order, and changes no balance', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, c1);
    const f1 = await createAccount(built.app, c1);
    expect((await deposit(built.app, o1, a1.id, '1000')).statusCode).toBe(201);
    expect((await deposit(built.app, o1, f1.id, '1000')).statusCode).toBe(201);
    expect((await changeStatus(built.app, o1, f1.id, 'freeze')).statusCode).toBe(200);
    const u = randomUUID();

    const unparsable = '{"amount": "100", "currency": "EUR"';
    const json = { 'content-type': 'application/json' };
    const send = async (
      accountId: string,
      headers: Record<string, string>,
      payload: string | Record<string, unknown>,
    ) =>
      await built.app.inject({
        method: 'POST',
        url: `/v1/accounts/${accountId}/deposits`,
        headers: { ...json, ...headers },
        payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
      });
    const valid = { amount: '100', currency: 'EUR' };
    const notMinorUnits = { amount: '10.50', currency: 'EUR' };

    const answers = [
      await send(a1.id, { 'idempotency-key': freshKey() }, unparsable),
      await send(a1.id, { ...bearer(c1), 'idempotency-key': freshKey() }, unparsable),
      await send(a1.id, bearer(o1), notMinorUnits),
      await send(u, { ...bearer(o1), 'idempotency-key': freshKey() }, notMinorUnits),
      await send(u, { ...bearer(o1), 'idempotency-key': freshKey() }, valid),
      await send(f1.id, { ...bearer(o1), 'idempotency-key': freshKey() }, valid),
    ];
    expect(answers.map((answer) => [answer.statusCode, problemOf(answer).type])).toEqual([
      [401, '/problems/unauthenticated'],
      [403, '/problems/forbidden'],
      [400, '/problems/malformed-request'],
      [422, '/problems/validation-error'],
      [404, '/problems/not-found'],
      [422, '/problems/account-not-active'],
    ]);

    for (const account of [a1, f1]) {
      const read = await built.app.inject({
        method: 'GET',
        url: `/v1/accounts/${account.id}`,
        headers: bearer(c1),
      });
      expect(read.json<AccountJson>().balance).toBe('1000');
    }
  });
});
