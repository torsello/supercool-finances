import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { bearer, createAccount, deposit, problemOf, type AccountJson } from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';

describe('currencies (SYS-R06, SYS-R08, SYS-R09)', () => {
  let built: BuiltApp;
  const o1 = tokenFor(randomUUID(), 'operator');

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
  });

  async function balanceOf(token: string, accountId: string): Promise<[string, string]> {
    const response = await built.app.inject({
      method: 'GET',
      url: `/v1/accounts/${accountId}`,
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(200);
    const account = response.json<AccountJson>();
    return [account.balance, account.currency];
  }

  it('SYS-AC05 refuses a deposit in an unsupported currency with a validation error on the currency', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const a1 = await createAccount(built.app, c1);
    expect((await deposit(built.app, o1, a1.id, '10000')).statusCode).toBe(201);

    for (const currency of ['GBP', 'eur', '']) {
      const response = await deposit(built.app, o1, a1.id, '100', { currency });
      expect(response.statusCode, currency).toBe(422);
      const problem = problemOf(response);
      expect(problem.type, currency).toBe('/problems/validation-error');
      expect(problem['errors'], currency).toEqual([
        { pointer: '/currency', detail: expect.any(String) as unknown },
      ]);
    }
    expect(await balanceOf(c1, a1.id)).toEqual(['10000', 'EUR']);
  });

  it('SYS-AC07 takes JPY amounts in whole yen and refuses a decimal amount', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const j1 = await createAccount(built.app, c1, 'JPY');
    expect(await balanceOf(c1, j1.id)).toEqual(['0', 'JPY']);

    const whole = await deposit(built.app, o1, j1.id, '1500', { currency: 'JPY' });
    expect(whole.statusCode).toBe(201);
    expect(await balanceOf(c1, j1.id)).toEqual(['1500', 'JPY']);

    const decimal = await deposit(built.app, o1, j1.id, '15.00', { currency: 'JPY' });
    expect(decimal.statusCode).toBe(422);
    expect(problemOf(decimal).type).toBe('/problems/validation-error');
    expect(await balanceOf(c1, j1.id)).toEqual(['1500', 'JPY']);
  });
});
