import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import {
  bearer,
  changeStatus,
  createAccount,
  deposit,
  problemOf,
  transfer,
  withdraw,
  type AccountJson,
} from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';

interface EntryJson {
  kind: string;
  amount: string;
}

describe('what a frozen or closed account allows', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
  });

  const o1 = tokenFor(randomUUID(), 'operator');

  async function funded(token: string, amount: string): Promise<AccountJson> {
    const account = await createAccount(built.app, token);
    expect((await deposit(built.app, o1, account.id, amount)).statusCode).toBe(201);
    return account;
  }

  async function read(token: string, id: string): Promise<AccountJson> {
    const response = await built.app.inject({
      method: 'GET',
      url: `/v1/accounts/${id}`,
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(200);
    return response.json<AccountJson>();
  }

  async function history(token: string, id: string): Promise<EntryJson[]> {
    const response = await built.app.inject({
      method: 'GET',
      url: `/v1/accounts/${id}/entries`,
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ items: EntryJson[] }>().items;
  }

  function rejected(response: LightMyRequestResponse, type: string, label: string): void {
    expect(response.statusCode, label).toBe(422);
    expect(problemOf(response).type, label).toBe(type);
  }

  it('ACC-AC16 a frozen account can neither send nor receive money, and can still be read and listed', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const c2 = tokenFor(randomUUID(), 'customer');
    const f1 = await funded(c1, '5000');
    await funded(c1, '1000');
    const b1 = await funded(c2, '1000');
    expect((await changeStatus(built.app, o1, f1.id, 'freeze')).statusCode).toBe(200);
    const entriesBefore = await history(c1, f1.id);

    rejected(
      await withdraw(built.app, c1, f1.id, '100'),
      '/problems/account-not-active',
      'withdrawal',
    );
    rejected(
      await transfer(built.app, c1, f1.id, b1.id, '100'),
      '/problems/account-not-active',
      'transfer out',
    );
    rejected(
      await transfer(built.app, c2, b1.id, f1.id, '100'),
      '/problems/destination-unavailable',
      'transfer in',
    );
    rejected(await deposit(built.app, o1, f1.id, '100'), '/problems/account-not-active', 'deposit');

    expect(await read(c1, f1.id)).toMatchObject({ status: 'frozen', balance: '5000' });
    expect(await read(o1, f1.id)).toMatchObject({ status: 'frozen', balance: '5000' });
    expect(await read(c2, b1.id)).toMatchObject({ balance: '1000' });
    expect(await history(c1, f1.id)).toEqual(entriesBefore);
    expect(await history(o1, f1.id)).toEqual(entriesBefore);
  });

  it('ACC-AC17 a closed account can neither send nor receive money, and can still be read with its history', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const c2 = tokenFor(randomUUID(), 'customer');
    const x1 = await funded(c1, '500');
    expect((await withdraw(built.app, c1, x1.id, '500')).statusCode).toBe(201);
    expect((await changeStatus(built.app, o1, x1.id, 'close')).statusCode).toBe(200);
    const b1 = await funded(c2, '1000');

    rejected(await deposit(built.app, o1, x1.id, '100'), '/problems/account-not-active', 'deposit');
    rejected(
      await transfer(built.app, c2, b1.id, x1.id, '100'),
      '/problems/destination-unavailable',
      'transfer in',
    );
    rejected(
      await withdraw(built.app, c1, x1.id, '1'),
      '/problems/account-not-active',
      'withdrawal',
    );

    expect(await read(c1, x1.id)).toMatchObject({ status: 'closed', balance: '0' });
    expect(await read(c2, b1.id)).toMatchObject({ balance: '1000' });
    const entries = await history(c1, x1.id);
    expect(entries.map(({ kind, amount }) => ({ kind, amount }))).toEqual([
      { kind: 'withdrawal', amount: '-500' },
      { kind: 'deposit', amount: '500' },
    ]);
  });
});
