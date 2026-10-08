import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { closePools, runtimePool } from '../../support/db.js';
import {
  bearer,
  changeStatus,
  createAccount,
  deposit,
  freshKey,
  problemOf,
  reverse,
  transfer,
  withdraw,
  withoutRequestId,
  type AccountJson,
} from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';

const FORBIDDEN = {
  type: '/problems/forbidden',
  title: 'Forbidden',
  status: 403,
};

/** The stored status and balance of an account. */
async function stateOf(accountId: string): Promise<{ status: string; balance: string }> {
  const result = await runtimePool().query<{ status: string; balance: string }>(
    'SELECT status, balance FROM accounts WHERE id = $1',
    [accountId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`No account ${accountId}`);
  return row;
}

async function countOf(sql: string, values: unknown[]): Promise<number> {
  const result = await runtimePool().query<{ count: string }>(sql, values);
  return Number(result.rows[0]?.count ?? 'NaN');
}

/** Idempotency records stored under any of `keys`. */
async function keyRecords(keys: string[]): Promise<number> {
  return await countOf('SELECT count(*) FROM idempotency_keys WHERE key = ANY ($1::text[])', [
    keys,
  ]);
}

/** Every response is a 403 forbidden problem, and the bodies differ only in `requestId`. */
function expectSameForbidden(responses: [string, LightMyRequestResponse][]): void {
  const bodies = responses.map(([name, response]) => {
    expect(response.statusCode, name).toBe(403);
    const body = withoutRequestId(problemOf(response));
    expect(body, name).toMatchObject(FORBIDDEN);
    return body;
  });
  for (const body of bodies) expect(body).toEqual(bodies[0]);
}

describe('the role check', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  async function funded(owner: string, operator: string, amount: string) {
    const account = await createAccount(built.app, owner);
    const response = await deposit(built.app, operator, account.id, amount);
    expect(response.statusCode).toBe(201);
    return { account, depositId: response.json<{ id: string }>().id };
  }

  it('AUT-AC07 answers 403 to a customer on every operator-only endpoint, whatever the ids, and changes nothing', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const c2 = tokenFor(randomUUID(), 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const { account: a1, depositId: d } = await funded(c1, o1, '1000');
    const { account: b1 } = await funded(c2, o1, '1000');
    const u = randomUUID();

    const keys: string[] = [];
    const key = (): string => {
      const fresh = freshKey();
      keys.push(fresh);
      return fresh;
    };
    const responses: [string, LightMyRequestResponse][] = [];
    for (const [name, id] of [
      ['A1', a1.id],
      ['B1', b1.id],
      ['U', u],
    ] as const) {
      responses.push([`deposit ${name}`, await deposit(built.app, c1, id, '100', { key: key() })]);
      for (const action of ['freeze', 'unfreeze', 'close'] as const) {
        responses.push([`${action} ${name}`, await changeStatus(built.app, c1, id, action)]);
      }
    }
    responses.push([
      'reverse D',
      await reverse(built.app, c1, d, { reason: 'duplicate', key: key() }),
    ]);
    responses.push([
      'reverse U',
      await reverse(built.app, c1, u, { reason: 'duplicate', key: key() }),
    ]);

    expect(responses).toHaveLength(14);
    expectSameForbidden(responses);
    for (const account of [a1, b1]) {
      expect(await stateOf(account.id)).toEqual({ status: 'active', balance: '1000' });
    }
    expect(
      await countOf('SELECT count(*) FROM transactions WHERE reversed_transaction_id = $1', [d]),
    ).toBe(0);
    expect(await keyRecords(keys)).toBe(0);
  });

  it('AUT-AC08 answers 403 to an operator on every customer-only endpoint, whatever the ids, and changes nothing', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const c2 = tokenFor(randomUUID(), 'customer');
    const o1Id = randomUUID();
    const o1 = tokenFor(o1Id, 'operator');
    const { account: a1 } = await funded(c1, tokenFor(randomUUID(), 'operator'), '1000');
    const b1: AccountJson = await createAccount(built.app, c2);
    const u = randomUUID();
    const entriesBefore = await countOf(
      'SELECT count(*) FROM ledger_entries WHERE account_id = ANY ($1::uuid[])',
      [[a1.id, b1.id]],
    );

    const keys = [freshKey(), freshKey(), freshKey(), freshKey()];
    const [k1 = '', k2 = '', k3 = '', k4 = ''] = keys;
    const responses: [string, LightMyRequestResponse][] = [
      [
        'create',
        await built.app.inject({
          method: 'POST',
          url: '/v1/accounts',
          headers: bearer(o1),
          payload: { currency: 'EUR' },
        }),
      ],
      ['list', await built.app.inject({ method: 'GET', url: '/v1/accounts', headers: bearer(o1) })],
      ['withdraw A1', await withdraw(built.app, o1, a1.id, '100', { key: k1 })],
      ['withdraw U', await withdraw(built.app, o1, u, '100', { key: k2 })],
      ['transfer A1', await transfer(built.app, o1, a1.id, b1.id, '100', { key: k3 })],
      ['transfer U', await transfer(built.app, o1, u, b1.id, '100', { key: k4 })],
    ];

    expectSameForbidden(responses);
    expect(await countOf('SELECT count(*) FROM accounts WHERE owner_id = $1', [o1Id])).toBe(0);
    expect((await stateOf(a1.id)).balance).toBe('1000');
    expect((await stateOf(b1.id)).balance).toBe('0');
    expect(
      await countOf('SELECT count(*) FROM ledger_entries WHERE account_id = ANY ($1::uuid[])', [
        [a1.id, b1.id],
      ]),
    ).toBe(entriesBefore);
    expect(await countOf('SELECT count(*) FROM audit_records WHERE actor_id = $1', [o1Id])).toBe(0);
    expect(await keyRecords(keys)).toBe(0);
    expect(await countOf('SELECT count(*) FROM idempotency_keys WHERE user_id = $1', [o1Id])).toBe(
      0,
    );
  });
});
