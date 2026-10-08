import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import {
  bearer,
  changeStatus,
  createAccount,
  deposit,
  problemOf,
  withdraw,
  type AccountJson,
} from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';

const RUNS = 20;

describe('status changes racing movements', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
  });

  async function read(token: string, id: string): Promise<AccountJson> {
    const response = await built.app.inject({
      method: 'GET',
      url: `/v1/accounts/${id}`,
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(200);
    return response.json<AccountJson>();
  }

  it('ACC-AC14 a close racing a deposit and a freeze racing a withdrawal take effect one after the other, 20 times each', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');

    for (let run = 0; run < RUNS; run += 1) {
      const a1 = await createAccount(built.app, c1);
      const [close, credit] = await Promise.all([
        changeStatus(built.app, o1, a1.id, 'close'),
        deposit(built.app, o1, a1.id, '100'),
      ]);
      const after = await read(o1, a1.id);
      if (close.statusCode === 200) {
        expect(credit.statusCode, `run ${String(run)}`).toBe(422);
        expect(problemOf(credit).type).toBe('/problems/account-not-active');
        expect(after).toMatchObject({ status: 'closed', balance: '0' });
      } else {
        expect(credit.statusCode, `run ${String(run)}`).toBe(201);
        expect(close.statusCode, `run ${String(run)}`).toBe(409);
        expect(problemOf(close).type).toBe('/problems/account-balance-not-zero');
        expect(after).toMatchObject({ status: 'active', balance: '100' });
      }
      if (after.status === 'closed') expect(after.balance).toBe('0');

      const a2 = await createAccount(built.app, c1);
      expect((await deposit(built.app, o1, a2.id, '1000')).statusCode).toBe(201);
      const [freeze, debit] = await Promise.all([
        changeStatus(built.app, o1, a2.id, 'freeze'),
        withdraw(built.app, c1, a2.id, '1000'),
      ]);
      expect(freeze.statusCode, `run ${String(run)}`).toBe(200);
      const frozen = await read(o1, a2.id);
      if (debit.statusCode === 201) {
        expect(frozen).toMatchObject({ status: 'frozen', balance: '0' });
      } else {
        expect(debit.statusCode, `run ${String(run)}`).toBe(422);
        expect(problemOf(debit).type).toBe('/problems/account-not-active');
        expect(frozen).toMatchObject({ status: 'frozen', balance: '1000' });
      }
    }
  });
});
