import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { balanceOf, closePools } from '../../support/db.js';
import { LOG_LEVEL } from '../../support/logs.js';
import {
  bearer,
  createAccount,
  deposit,
  freshKey,
  problemOf,
  withdraw,
} from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';
import { writtenRows } from '../movements/support.js';
import { keyRowOf } from './support.js';

/** A body that parses as JSON but that RFC 8785 cannot encode (IDM-R05). */
const HUGE_NUMBER = '{"amount":1e400,"currency":"EUR"}';
const DEEP_ARRAYS = `${'['.repeat(3000)}${']'.repeat(3000)}`;

describe('a keyed request whose body RFC 8785 cannot encode', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('IDM-R05 IDM-R01 a deposit with amount 1e400 and a transfer of 3000 nested arrays answer 400 without a key, 422 validation-error with nothing written and no error log line with a fresh key, and 422 idempotency-key-reused with the key of a stored movement', async () => {
    const c1 = randomUUID();
    const o1 = randomUUID();
    const customer = tokenFor(c1, 'customer');
    const operator = tokenFor(o1, 'operator');
    const a1 = await createAccount(built.app, customer, 'EUR');
    const b1 = await createAccount(built.app, tokenFor(randomUUID(), 'customer'), 'EUR');
    const depositKey = freshKey();
    expect(
      (await deposit(built.app, operator, a1.id, '1000', { key: depositKey })).statusCode,
    ).toBe(201);
    // A customer never deposits, so the transfer reuses the key of the customer's stored withdrawal.
    const withdrawalKey = freshKey();
    expect(
      (await withdraw(built.app, customer, a1.id, '100', { key: withdrawalKey })).statusCode,
    ).toBe(201);
    const storedDeposit = await keyRowOf(o1, depositKey);
    const storedWithdrawal = await keyRowOf(c1, withdrawalKey);
    const before = await writtenRows();
    built.logs.clear();

    const cases = [
      {
        url: `/v1/accounts/${a1.id}/deposits`,
        token: operator,
        user: o1,
        body: HUGE_NUMBER,
        storedKey: depositKey,
      },
      {
        url: `/v1/accounts/${a1.id}/transfers`,
        token: customer,
        user: c1,
        body: DEEP_ARRAYS,
        storedKey: withdrawalKey,
      },
    ];
    for (const { url, token, user, body, storedKey } of cases) {
      const send = (key?: string) =>
        built.app.inject({
          method: 'POST',
          url,
          headers: {
            ...bearer(token),
            'content-type': 'application/json',
            ...(key === undefined ? {} : { 'idempotency-key': key }),
          },
          payload: body,
        });

      const withoutKey = await send();
      expect(withoutKey.statusCode, url).toBe(400);
      expect(problemOf(withoutKey).type).toBe('/problems/malformed-request');

      const key = freshKey();
      const fresh = await send(key);
      expect(fresh.statusCode, url).toBe(422);
      expect(problemOf(fresh).type).toBe('/problems/validation-error');
      expect(await keyRowOf(user, key)).toBeUndefined();

      const reused = await send(storedKey);
      expect(reused.statusCode, url).toBe(422);
      expect(problemOf(reused).type).toBe('/problems/idempotency-key-reused');
    }

    expect(await writtenRows()).toEqual(before);
    expect(await balanceOf(a1.id)).toBe('900');
    expect(await balanceOf(b1.id)).toBe('0');
    expect(await keyRowOf(o1, depositKey)).toEqual(storedDeposit);
    expect(await keyRowOf(c1, withdrawalKey)).toEqual(storedWithdrawal);
    expect(built.logs.lines().filter((line) => (line.level ?? 0) >= LOG_LEVEL.error)).toEqual([]);
  });
});
