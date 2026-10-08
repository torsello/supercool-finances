import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '../../../src/platform/http/problem.js';
import {
  THROWING_ROUTE_MESSAGE,
  THROWING_ROUTE_PATH,
  buildTestApp,
  type BuiltTestApp,
} from '../../support/test-app.js';
import {
  bearer,
  createAccount,
  deposit,
  freshKey,
  problemOf,
  type AccountJson,
} from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';

/** Marks of internals a problem body must never hold (SYS-R24). */
const INTERNALS = [THROWING_ROUTE_MESSAGE, 'stack', '    at ', 'SELECT', 'INSERT', 'UPDATE ', 'pg'];

describe('problem details (SYS-R24 to SYS-R27)', () => {
  let built: BuiltTestApp;
  const o1 = randomUUID();
  const operator = tokenFor(o1, 'operator');

  beforeAll(async () => {
    built = buildTestApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
  });

  async function balanceOf(token: string, accountId: string): Promise<string> {
    const response = await built.app.inject({
      method: 'GET',
      url: `/v1/accounts/${accountId}`,
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(200);
    return response.json<AccountJson>().balance;
  }

  it('SYS-AC20 answers a refused body and a thrown error as problem details without internals', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const a1 = await createAccount(built.app, c1);

    const refused = await built.app.inject({
      method: 'POST',
      url: `/v1/accounts/${a1.id}/deposits`,
      headers: { ...bearer(operator), 'idempotency-key': freshKey() },
      payload: { amount: 1050, currency: 'EUR' },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.headers['content-type']).toBe('application/problem+json');
    const validation = problemOf(refused);
    expect(validation).toEqual({
      type: '/problems/validation-error',
      title: PROBLEM_TYPES['/problems/validation-error'].title,
      status: 422,
      detail: PROBLEM_TYPES['/problems/validation-error'].detail,
      requestId: expect.any(String) as unknown,
      errors: [{ pointer: '/amount', detail: expect.any(String) as unknown }],
    });

    const thrown = await built.app.inject({
      method: 'GET',
      url: THROWING_ROUTE_PATH,
      headers: bearer(operator),
    });
    expect(thrown.statusCode).toBe(500);
    expect(thrown.headers['content-type']).toBe('application/problem+json');
    expect(problemOf(thrown)).toEqual({
      type: '/problems/internal-error',
      title: PROBLEM_TYPES['/problems/internal-error'].title,
      status: 500,
      detail: PROBLEM_TYPES['/problems/internal-error'].detail,
      requestId: expect.any(String) as unknown,
    });

    for (const body of [refused.body, thrown.body]) {
      for (const mark of INTERNALS) expect(body).not.toContain(mark);
    }
    expect(await balanceOf(c1, a1.id)).toBe('0');
  });

  it('SYS-AC21 answers a broken request 400 and a refused one 422, and changes nothing', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const a1 = await createAccount(built.app, c1);
    expect((await deposit(built.app, operator, a1.id, '10000')).statusCode).toBe(201);
    const url = `/v1/accounts/${a1.id}/withdrawals`;
    const valid = { amount: '100', currency: 'EUR' };

    const unparsable = await built.app.inject({
      method: 'POST',
      url,
      headers: { ...bearer(c1), 'idempotency-key': freshKey(), 'content-type': 'application/json' },
      payload: '{"amount": "100", "currency": "EUR"',
    });
    const withoutKey = await built.app.inject({
      method: 'POST',
      url,
      headers: bearer(c1),
      payload: valid,
    });
    const emptyKey = await built.app.inject({
      method: 'POST',
      url,
      headers: { ...bearer(c1), 'idempotency-key': '' },
      payload: valid,
    });
    const badCursor = await built.app.inject({
      method: 'GET',
      url: `/v1/accounts/${a1.id}/entries?cursor=not-a-cursor`,
      headers: bearer(c1),
    });
    for (const [name, response] of Object.entries({
      unparsable,
      withoutKey,
      emptyKey,
      badCursor,
    })) {
      expect(response.statusCode, name).toBe(400);
      expect(problemOf(response).type, name).toBe('/problems/malformed-request');
    }
    expect(problemOf(unparsable).detail).toMatch(/body/i);
    expect(problemOf(withoutKey).detail).toMatch(/Idempotency-Key/);
    expect(problemOf(emptyKey).detail).toMatch(/Idempotency-Key/);
    expect(problemOf(badCursor).detail).toMatch(/cursor/i);

    const unknownField = await built.app.inject({
      method: 'POST',
      url,
      headers: { ...bearer(c1), 'idempotency-key': freshKey() },
      payload: { amount: '100', currency: 'EUR', fee: '1' },
    });
    expect(unknownField.statusCode).toBe(422);
    const unknown = problemOf(unknownField);
    expect(unknown.type).toBe('/problems/validation-error');
    expect(unknown['errors']).toEqual([{ pointer: '/fee', detail: expect.any(String) as unknown }]);

    const twoFields = await built.app.inject({
      method: 'POST',
      url,
      headers: { ...bearer(c1), 'idempotency-key': freshKey() },
      payload: { amount: '10.50' },
    });
    expect(twoFields.statusCode).toBe(422);
    const two = problemOf(twoFields);
    expect(two.type).toBe('/problems/validation-error');
    expect(two['errors']).toEqual([
      { pointer: '/amount', detail: expect.any(String) as unknown },
      { pointer: '/currency', detail: expect.any(String) as unknown },
    ]);

    expect(await balanceOf(c1, a1.id)).toBe('10000');
  });
});
