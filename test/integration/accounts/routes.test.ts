import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { closePools, runtimePool } from '../../support/db.js';
import {
  bearer,
  createAccount,
  problemOf,
  withoutRequestId,
  type AccountJson,
} from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';

describe('the account routes', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('ACC-R07 answers a read of an own account with exactly the representation of section 1.3', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const created = await createAccount(built.app, c1, 'JPY');

    for (const id of [created.id, created.id.toUpperCase()]) {
      const response = await built.app.inject({
        method: 'GET',
        url: `/v1/accounts/${id}`,
        headers: bearer(c1),
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      const body = response.json<AccountJson>();
      expect(Object.keys(body).sort()).toEqual(
        ['balance', 'createdAt', 'currency', 'id', 'status', 'updatedAt'].sort(),
      );
      expect(body).toEqual({
        id: created.id,
        currency: 'JPY',
        status: 'active',
        balance: '0',
        createdAt: created.createdAt,
        updatedAt: created.createdAt,
      });
      expect(body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  it('SYS-R42 SYS-R31 answers an id that is not a UUID, longer than 100 characters too, with 401 without credentials and the unknown-id 404 with them', async () => {
    const customer = tokenFor(randomUUID(), 'customer');
    const operator = tokenFor(randomUUID(), 'operator');
    const routes = [
      { method: 'GET', suffix: '', tokens: [customer, operator] },
      { method: 'GET', suffix: '/entries', tokens: [customer, operator] },
      { method: 'POST', suffix: '/freeze', tokens: [operator] },
      { method: 'POST', suffix: '/unfreeze', tokens: [operator] },
      { method: 'POST', suffix: '/close', tokens: [operator] },
    ] as const;
    const ids = [
      'not-a-uuid',
      'a'.repeat(101),
      `${randomUUID()}${'0'.repeat(80)}`,
      'f'.repeat(10_000),
    ];

    for (const route of routes) {
      for (const token of route.tokens) {
        const unknown = await built.app.inject({
          method: route.method,
          url: `/v1/accounts/${randomUUID()}${route.suffix}`,
          headers: bearer(token),
        });
        expect(unknown.statusCode).toBe(404);
        const unknownBody = withoutRequestId(problemOf(unknown));
        expect(unknownBody['type']).toBe('/problems/not-found');

        for (const id of ids) {
          const label = `${route.method} ${route.suffix} id of ${String(id.length)} characters`;
          const url = `/v1/accounts/${id}${route.suffix}`;

          const anonymous = await built.app.inject({ method: route.method, url });
          expect(anonymous.statusCode, label).toBe(401);
          expect(problemOf(anonymous).type, label).toBe('/problems/unauthenticated');

          const authenticated = await built.app.inject({
            method: route.method,
            url,
            headers: bearer(token),
          });
          expect(authenticated.statusCode, label).toBe(404);
          expect(withoutRequestId(problemOf(authenticated)), label).toEqual(unknownBody);
        }
      }
    }
  });

  it('ACC-R23 ACC-R24 AUT-R09 SYS-R31 checks the cursor of the account list before validation, then limit and unknown parameters', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const c2 = tokenFor(randomUUID(), 'customer');
    for (let index = 0; index < 2; index += 1) await createAccount(built.app, c1);
    const first = await built.app.inject({
      method: 'GET',
      url: '/v1/accounts?limit=1',
      headers: bearer(c1),
    });
    const cursor = first.json<{ nextCursor?: string }>().nextCursor ?? '';
    expect(cursor).not.toBe('');

    const status = async (token: string, query: string) => {
      const response = await built.app.inject({
        method: 'GET',
        url: `/v1/accounts?${query}`,
        headers: bearer(token),
      });
      return { code: response.statusCode, body: problemOf(response) };
    };

    for (const [token, query] of [
      [c2, `cursor=${cursor}`],
      [c1, 'cursor=not-a-cursor'],
      [c1, `cursor=${cursor}&cursor=${cursor}`],
      [c1, 'cursor=not-a-cursor&limit=0&ownerId=x'],
    ] as const) {
      const { code, body } = await status(token, query);
      expect(code, query).toBe(400);
      expect(body.type).toBe('/problems/malformed-request');
      expect(body.detail).toMatch(/cursor/);
    }
    for (const limit of ['0', '101', 'abc', '01', '1.5', '']) {
      const { code, body } = await status(c1, `limit=${limit}`);
      expect(code, limit).toBe(422);
      expect(body['errors'], limit).toEqual([
        { parameter: 'limit', detail: 'Must be an integer from 1 to 100.' },
      ]);
    }
    const unknown = await status(c1, 'ownerId=someone&limit=1');
    expect(unknown.code).toBe(422);
    expect(unknown.body['errors']).toEqual([
      { parameter: 'ownerId', detail: 'Unknown parameter.' },
    ]);
  });

  /** What a status change would alter: the stored status and the audit records of the account. */
  async function stored(accountId: string): Promise<{ status: string | null; audits: string }> {
    const account = await runtimePool().query<{ status: string | null }>(
      'SELECT status FROM accounts WHERE id = $1',
      [accountId],
    );
    const audits = await runtimePool().query<{ count: string }>(
      'SELECT count(*) FROM audit_records WHERE $1::uuid = ANY (account_ids)',
      [accountId],
    );
    return { status: account.rows[0]?.status ?? null, audits: audits.rows[0]?.count ?? '' };
  }

  async function ownedCount(ownerId: string): Promise<string> {
    const result = await runtimePool().query<{ count: string }>(
      'SELECT count(*) FROM accounts WHERE owner_id = $1',
      [ownerId],
    );
    return result.rows[0]?.count ?? '';
  }

  it('AUT-R09 SYS-R27 answers an unknown query parameter on each of the seven routes with 422 and one parameter entry, changing nothing', async () => {
    const c1 = randomUUID();
    const customer = tokenFor(c1, 'customer');
    const operator = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, customer);
    const before = await stored(a1.id);
    const accounts = await ownedCount(c1);
    const requests = [
      { method: 'POST', url: '/v1/accounts', token: customer, payload: { currency: 'EUR' } },
      { method: 'GET', url: '/v1/accounts', token: customer },
      { method: 'GET', url: `/v1/accounts/${a1.id}`, token: customer },
      { method: 'GET', url: `/v1/accounts/${a1.id}/entries`, token: customer },
      { method: 'POST', url: `/v1/accounts/${a1.id}/freeze`, token: operator },
      { method: 'POST', url: `/v1/accounts/${a1.id}/unfreeze`, token: operator },
      { method: 'POST', url: `/v1/accounts/${a1.id}/close`, token: operator },
    ] as const;

    for (const request of requests) {
      const label = `${request.method} ${request.url}`;
      const response = await built.app.inject({
        method: request.method,
        url: `${request.url}?note=x`,
        headers: bearer(request.token),
        ...('payload' in request ? { payload: request.payload } : {}),
      });
      expect(response.statusCode, label).toBe(422);
      const body = problemOf(response);
      expect(body.type, label).toBe('/problems/validation-error');
      expect(body['errors'], label).toEqual([{ parameter: 'note', detail: 'Unknown parameter.' }]);
    }
    expect(await stored(a1.id)).toEqual(before);
    expect(await ownedCount(c1)).toBe(accounts);
  });

  it('AUT-R09 SYS-R27 answers an unknown body member on each status route with 422 and one pointer entry, changing nothing, and accepts an empty object', async () => {
    const customer = tokenFor(randomUUID(), 'customer');
    const operator = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, customer);
    const before = await stored(a1.id);

    for (const action of ['freeze', 'unfreeze', 'close'] as const) {
      const response = await built.app.inject({
        method: 'POST',
        url: `/v1/accounts/${a1.id}/${action}`,
        headers: bearer(operator),
        payload: { note: 'x', status: 'closed' },
      });
      expect(response.statusCode, action).toBe(422);
      expect(problemOf(response)['errors'], action).toEqual([
        { pointer: '/note', detail: 'Unknown member.' },
        { pointer: '/status', detail: 'Unknown member.' },
      ]);
    }
    expect(await stored(a1.id)).toEqual(before);

    const empty = await built.app.inject({
      method: 'POST',
      url: `/v1/accounts/${a1.id}/freeze`,
      headers: bearer(operator),
      payload: {},
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json<AccountJson>().status).toBe('frozen');
  });

  it('AUT-R09 SYS-R31 answers an unknown member at the validation step: after the role check, before the lookup', async () => {
    const customer = tokenFor(randomUUID(), 'customer');
    const operator = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, customer);

    const forbidden = await built.app.inject({
      method: 'POST',
      url: `/v1/accounts/${a1.id}/freeze?note=x`,
      headers: bearer(customer),
      payload: { note: 'x' },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(problemOf(forbidden).type).toBe('/problems/forbidden');

    for (const request of [
      { method: 'GET', url: `/v1/accounts/${randomUUID()}?note=x`, token: customer },
      { method: 'GET', url: '/v1/accounts/not-a-uuid?note=x', token: operator },
      { method: 'POST', url: `/v1/accounts/${randomUUID()}/close?note=x`, token: operator },
    ] as const) {
      const response = await built.app.inject({
        method: request.method,
        url: request.url,
        headers: bearer(request.token),
      });
      expect(response.statusCode, request.url).toBe(422);
      expect(problemOf(response).type, request.url).toBe('/problems/validation-error');
    }
  });
});
