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
  withoutRequestId,
} from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';

describe('system accounts (SYS-R38, SYS-R42)', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  /** The balance of a system account: the sum of its entries (LED-R09). */
  async function systemBalance(accountId: string): Promise<string> {
    const result = await runtimePool().query<{ sum: string }>(
      'SELECT coalesce(sum(amount), 0)::text AS sum FROM ledger_entries WHERE account_id = $1',
      [accountId],
    );
    return result.rows[0]?.sum ?? '';
  }

  /** The audit records written for an actor. */
  async function auditsBy(actorId: string): Promise<number> {
    const result = await runtimePool().query<{ count: string }>(
      'SELECT count(*) AS count FROM audit_records WHERE actor_id = $1',
      [actorId],
    );
    return Number(result.rows[0]?.count);
  }

  it('SYS-AC25 answers every request of an operator on a system account as the 404 of an unknown account', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const o1Id = randomUUID();
    const o1 = tokenFor(o1Id, 'operator');
    const a1 = await createAccount(built.app, c1);
    expect((await deposit(built.app, o1, a1.id, '1000')).statusCode).toBe(201);
    const s = await settlementAccountId('EUR');
    const u = randomUUID();
    const before = await systemBalance(s);

    const get = async (url: string) =>
      await built.app.inject({ method: 'GET', url, headers: bearer(o1) });
    const unknown = await get(`/v1/accounts/${u}`);
    expect(unknown.statusCode).toBe(404);
    const expected = withoutRequestId(problemOf(unknown));

    const requests: [string, LightMyRequestResponse][] = [
      ['read S', await get(`/v1/accounts/${s}`)],
      ['history of S', await get(`/v1/accounts/${s}/entries`)],
      ['deposit into S', await deposit(built.app, o1, s, '100')],
      ['freeze S', await changeStatus(built.app, o1, s, 'freeze')],
      ['unfreeze S', await changeStatus(built.app, o1, s, 'unfreeze')],
      ['close S', await changeStatus(built.app, o1, s, 'close')],
      ['account not-a-uuid', await get('/v1/accounts/not-a-uuid')],
      ['transaction not-a-uuid', await get('/v1/transactions/not-a-uuid')],
    ];
    for (const [name, response] of requests) {
      expect(response.statusCode, name).toBe(404);
      expect(withoutRequestId(problemOf(response)), name).toEqual(expected);
    }

    expect(await systemBalance(s)).toBe(before);
    // Only the deposit into A1 was written by O1.
    expect(await auditsBy(o1Id)).toBe(1);
  });
});
