import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { closePools, runtimePool, settlementAccountId } from '../../support/db.js';
import {
  bearer,
  changeStatus,
  createAccount,
  deposit,
  problemOf,
  reverse,
  transfer,
  withdraw,
  withoutRequestId,
  type MovementJson,
} from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';

describe('roles (SYS-R03, SYS-R04)', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  /** The ledger rows, balances and statuses of the given accounts, to compare before and after. */
  async function stateOf(accountIds: string[]): Promise<unknown> {
    const accounts = await runtimePool().query(
      'SELECT id, status, balance FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id',
      [accountIds],
    );
    const entries = await runtimePool().query(
      `SELECT transaction_id, account_id, amount FROM ledger_entries
        WHERE account_id = ANY($1::uuid[]) ORDER BY transaction_id, account_id`,
      [accountIds],
    );
    return { accounts: accounts.rows, entries: entries.rows };
  }

  it('SYS-AC01 permits each operation only to its role, and a refused one changes nothing', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const c2 = tokenFor(randomUUID(), 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, c1);
    const b1 = await createAccount(built.app, c2);
    const b2 = await createAccount(built.app, c2);
    expect((await deposit(built.app, o1, a1.id, '10000')).statusCode).toBe(201);
    const u = randomUUID();
    const s = await settlementAccountId('EUR');
    const t = randomUUID();
    const watched = [a1.id, b1.id, b2.id];

    /** Sends a request the table does not permit: 403, and nothing changed. */
    async function refused(request: () => Promise<LightMyRequestResponse>, name: string) {
      const before = await stateOf(watched);
      const response = await request();
      expect(response.statusCode, name).toBe(403);
      expect(problemOf(response).type, name).toBe('/problems/forbidden');
      expect(await stateOf(watched), name).toEqual(before);
      return response;
    }

    /** Sends a request the table permits: it succeeds with `status`. */
    async function permitted(
      request: () => Promise<LightMyRequestResponse>,
      status: number,
      name: string,
    ) {
      const response = await request();
      expect(response.statusCode, `${name}: ${response.body}`).toBe(status);
      return response;
    }

    const read = (token: string, url: string) => async () =>
      await built.app.inject({ method: 'GET', url, headers: bearer(token) });

    // Read an account: both roles.
    await permitted(read(c1, `/v1/accounts/${a1.id}`), 200, 'C1 reads A1');
    await permitted(read(o1, `/v1/accounts/${a1.id}`), 200, 'O1 reads A1');

    // Deposit: operator only.
    const c1Deposit = await refused(
      async () => await deposit(built.app, c1, a1.id, '100'),
      'C1 deposits',
    );
    const d = (
      await permitted(async () => await deposit(built.app, o1, a1.id, '100'), 201, 'O1 deposits')
    ).json<MovementJson>();

    // Withdraw: customer only.
    await permitted(async () => await withdraw(built.app, c1, a1.id, '100'), 201, 'C1 withdraws');
    await refused(async () => await withdraw(built.app, o1, a1.id, '100'), 'O1 withdraws');

    // Transfer: customer only.
    const transferred = (
      await permitted(
        async () => await transfer(built.app, c1, a1.id, b1.id, '100'),
        201,
        'C1 transfers',
      )
    ).json<MovementJson>();
    await refused(async () => await transfer(built.app, o1, a1.id, b1.id, '100'), 'O1 transfers');

    // Read a transaction: both roles.
    await permitted(read(c1, `/v1/transactions/${transferred.id}`), 200, 'C1 reads the transfer');
    await permitted(read(o1, `/v1/transactions/${transferred.id}`), 200, 'O1 reads the transfer');

    // Reverse: operator only.
    await refused(async () => await reverse(built.app, c1, d.id), 'C1 reverses');
    await permitted(async () => await reverse(built.app, o1, d.id), 201, 'O1 reverses');

    // Freeze, unfreeze and close: operator only.
    for (const action of ['freeze', 'unfreeze', 'close'] as const) {
      await refused(async () => await changeStatus(built.app, c1, b2.id, action), `C1 ${action}`);
      await permitted(
        async () => await changeStatus(built.app, o1, b2.id, action),
        200,
        `O1 ${action}`,
      );
    }

    // A refused role gets the same 403 whatever the id: unknown, system or transaction.
    const expected = withoutRequestId(problemOf(c1Deposit));
    const sameRefusals: [string, () => Promise<LightMyRequestResponse>][] = [];
    for (const id of [u, s]) {
      sameRefusals.push([
        `C1 deposits into ${id}`,
        async () => await deposit(built.app, c1, id, '100'),
      ]);
      for (const action of ['freeze', 'unfreeze', 'close'] as const) {
        sameRefusals.push([
          `C1 ${action} ${id}`,
          async () => await changeStatus(built.app, c1, id, action),
        ]);
      }
    }
    sameRefusals.push(['C1 reverses T', async () => await reverse(built.app, c1, t)]);
    for (const [name, request] of sameRefusals) {
      const response = await refused(request, name);
      expect(withoutRequestId(problemOf(response)), name).toEqual(expected);
    }
  });
});
