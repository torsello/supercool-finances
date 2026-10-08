import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { closePools, runtimePool } from '../../support/db.js';
import { bearer, createAccount, freshKey, type MovementJson } from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';

interface AuditRow {
  actor_id: string;
  actor_role: string;
  action: string;
  account_ids: string[];
  transaction_id: string | null;
  request_id: string;
  created_at: Date;
}

describe('the audit record of a movement', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  /** Every audit record naming one of the accounts, oldest first. */
  async function auditsNaming(accountIds: string[]): Promise<AuditRow[]> {
    const result = await runtimePool().query<AuditRow>(
      `SELECT actor_id, actor_role, action, account_ids::text[] AS account_ids, transaction_id,
              request_id, created_at
       FROM audit_records WHERE account_ids && $1::uuid[] ORDER BY created_at, id`,
      [accountIds],
    );
    return result.rows;
  }

  async function post(
    token: string,
    url: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<LightMyRequestResponse> {
    return await built.app.inject({
      method: 'POST',
      url,
      headers: {
        ...bearer(token),
        'idempotency-key': freshKey(),
        ...(requestId === undefined ? {} : { 'x-request-id': requestId }),
      },
      payload,
    });
  }

  it('MOV-AC16 each applied movement writes one audit record with actor, role, action, accounts, correlation id, transaction and time; a refused one writes none', async () => {
    const c1Id = randomUUID();
    const o1Id = randomUUID();
    const c1 = tokenFor(c1Id, 'customer');
    const o1 = tokenFor(o1Id, 'operator');
    const a1 = await createAccount(built.app, c1, 'EUR');
    const b1 = await createAccount(built.app, tokenFor(randomUUID(), 'customer'), 'EUR');

    const deposited = await post(
      o1,
      `/v1/accounts/${a1.id}/deposits`,
      { amount: '1000', currency: 'EUR' },
      'req-d',
    );
    const withdrawn = await post(
      c1,
      `/v1/accounts/${a1.id}/withdrawals`,
      { amount: '100', currency: 'EUR' },
      'req-w',
    );
    const transferred = await post(
      c1,
      `/v1/accounts/${a1.id}/transfers`,
      { destinationAccountId: b1.id, amount: '200', currency: 'EUR' },
      'req-t',
    );
    const refused = await post(c1, `/v1/accounts/${a1.id}/withdrawals`, {
      amount: '999999',
      currency: 'EUR',
    });
    expect([deposited, withdrawn, transferred].map((r) => r.statusCode)).toEqual([201, 201, 201]);
    expect(refused.statusCode).toBe(422);

    const audits = await auditsNaming([a1.id, b1.id]);
    expect(audits).toHaveLength(3);
    const time = expect.any(Date) as unknown;
    expect(audits).toEqual([
      {
        actor_id: o1Id,
        actor_role: 'operator',
        action: 'deposit',
        account_ids: [a1.id],
        transaction_id: deposited.json<MovementJson>().id,
        request_id: 'req-d',
        created_at: time,
      },
      {
        actor_id: c1Id,
        actor_role: 'customer',
        action: 'withdrawal',
        account_ids: [a1.id],
        transaction_id: withdrawn.json<MovementJson>().id,
        request_id: 'req-w',
        created_at: time,
      },
      {
        actor_id: c1Id,
        actor_role: 'customer',
        action: 'transfer',
        account_ids: [a1.id, b1.id].sort(),
        transaction_id: transferred.json<MovementJson>().id,
        request_id: 'req-t',
        created_at: time,
      },
    ]);
    const refusedId = refused.json<{ requestId: string }>().requestId;
    expect(audits.map((audit) => audit.request_id)).not.toContain(refusedId);
  });
});
