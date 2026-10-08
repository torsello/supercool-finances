import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { closePools, runtimePool, settlementAccountId } from '../../support/db.js';
import {
  bearer,
  changeStatus,
  createAccount,
  problemOf,
  withoutRequestId,
  type AccountJson,
} from '../../support/http.js';
import { openLockSession } from '../../support/sessions.js';
import { tokenFor } from '../../support/tokens.js';

type Action = 'freeze' | 'unfreeze' | 'close';

async function storedStatus(accountId: string): Promise<string | null> {
  const result = await runtimePool().query<{ status: string | null }>(
    'SELECT status FROM accounts WHERE id = $1',
    [accountId],
  );
  return result.rows[0]?.status ?? null;
}

async function auditCount(accountId: string): Promise<number> {
  const result = await runtimePool().query<{ count: string }>(
    'SELECT count(*) FROM audit_records WHERE $1::uuid = ANY (account_ids)',
    [accountId],
  );
  return Number(result.rows[0]?.count ?? 'NaN');
}

describe('account status changes', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
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

  it('ACC-AC11 freeze, unfreeze and close take an account through the lifecycle, each answering 200 with the new status', async () => {
    const c1 = randomUUID();
    const customer = tokenFor(c1, 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, customer);
    const a2 = await createAccount(built.app, customer);

    const steps: [AccountJson, Action, string][] = [
      [a1, 'freeze', 'frozen'],
      [a1, 'unfreeze', 'active'],
      [a1, 'close', 'closed'],
      [a2, 'freeze', 'frozen'],
      [a2, 'close', 'closed'],
    ];
    const updatedAt = new Map([
      [a1.id, a1.updatedAt],
      [a2.id, a2.updatedAt],
    ]);
    for (const [account, action, status] of steps) {
      const response = await changeStatus(built.app, o1, account.id, action);
      expect(response.statusCode, `${action} ${account.id}`).toBe(200);
      const body = response.json<AccountJson>();
      expect(body).toMatchObject({ id: account.id, status, balance: '0', ownerId: c1 });
      expect(body.updatedAt >= (updatedAt.get(account.id) ?? '')).toBe(true);
      updatedAt.set(account.id, body.updatedAt);
      expect(await storedStatus(account.id)).toBe(status);
    }
  });

  it('ACC-AC12 closed is final, and requesting the status an account already has answers 200 with it unchanged', async () => {
    const customer = tokenFor(randomUUID(), 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const x1 = await createAccount(built.app, customer);
    const f1 = await createAccount(built.app, customer);
    const a1 = await createAccount(built.app, customer);
    expect((await changeStatus(built.app, o1, x1.id, 'close')).statusCode).toBe(200);
    expect((await changeStatus(built.app, o1, f1.id, 'freeze')).statusCode).toBe(200);
    const before = new Map<string, AccountJson>();
    for (const account of [x1, f1, a1]) before.set(account.id, await read(o1, account.id));

    for (const action of ['freeze', 'unfreeze'] as const) {
      const response = await changeStatus(built.app, o1, x1.id, action);
      expect(response.statusCode, action).toBe(409);
      expect(problemOf(response).type).toBe('/problems/invalid-status-transition');
      expect(await storedStatus(x1.id)).toBe('closed');
    }
    for (const [account, action] of [
      [x1, 'close'],
      [f1, 'freeze'],
      [a1, 'unfreeze'],
    ] as const) {
      const response = await changeStatus(built.app, o1, account.id, action);
      expect(response.statusCode, `${action} ${account.id}`).toBe(200);
      expect(response.json()).toEqual(before.get(account.id));
    }
  });

  it('ACC-AC15 a customer gets 403 for every status change of any account, with one body whatever the id', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const c2 = tokenFor(randomUUID(), 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, c1);
    const b1 = await createAccount(built.app, c2);
    expect((await changeStatus(built.app, o1, b1.id, 'freeze')).statusCode).toBe(200);
    const s = await settlementAccountId('EUR');
    const u = randomUUID();

    const bodies = [];
    for (const id of [a1.id, b1.id, s, u]) {
      for (const action of ['freeze', 'unfreeze', 'close'] as const) {
        const response = await changeStatus(built.app, c1, id, action);
        expect(response.statusCode, `${action} ${id}`).toBe(403);
        const body = problemOf(response);
        expect(body.type).toBe('/problems/forbidden');
        bodies.push(withoutRequestId(body));
      }
    }
    expect(bodies).toHaveLength(12);
    expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
    expect(await storedStatus(a1.id)).toBe('active');
    expect(await storedStatus(b1.id)).toBe('frozen');
  });

  it('ACC-AC25 a status change waits for the row lock at most ACCOUNT_LOCK_TIMEOUT_MS, then answers 503 with Retry-After: 1', async () => {
    const short = buildProductionApp({ env: { ACCOUNT_LOCK_TIMEOUT_MS: '200' } });
    const session = await openLockSession();
    try {
      await short.app.ready();
      const customer = tokenFor(randomUUID(), 'customer');
      const o1 = tokenFor(randomUUID(), 'operator');
      const a1 = await createAccount(short.app, customer);
      await session.lockRow('accounts', a1.id);

      for (const action of ['freeze', 'close'] as const) {
        const started = performance.now();
        const response = await changeStatus(short.app, o1, a1.id, action);
        const elapsed = performance.now() - started;
        expect(response.statusCode, action).toBe(503);
        expect(problemOf(response).type).toBe('/problems/service-unavailable');
        expect(response.headers['retry-after']).toBe('1');
        expect(elapsed, action).toBeGreaterThanOrEqual(200);
        expect(elapsed, action).toBeLessThan(5000);
      }
      expect(await storedStatus(a1.id)).toBe('active');
      expect(await auditCount(a1.id)).toBe(0);

      await session.release();
      const response = await changeStatus(short.app, o1, a1.id, 'freeze');
      expect(response.statusCode).toBe(200);
      expect(response.json<AccountJson>().status).toBe('frozen');
    } finally {
      await session.close();
      await short.app.close();
    }
  });
});
