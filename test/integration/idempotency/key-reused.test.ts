import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { balanceOf, closePools } from '../../support/db.js';
import { bearer, createAccount, deposit, problemOf, transfer } from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';
import { keyRowOf, transactionsOn } from './support.js';

describe('a key reused with another request', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('IDM-AC09 a key reused with another request answers 422 idempotency-key-reused, an invalid body included, and the same request with keys reordered replays', async () => {
    const c1 = randomUUID();
    const c1Token = tokenFor(c1, 'customer');
    const a1 = await createAccount(built.app, c1Token, 'EUR');
    const b1 = await createAccount(built.app, tokenFor(randomUUID(), 'customer'), 'EUR');
    await deposit(built.app, tokenFor(randomUUID(), 'operator'), a1.id, '1000');
    const withdrawWith = (payload: string) =>
      built.app.inject({
        method: 'POST',
        url: `/v1/accounts/${a1.id}/withdrawals`,
        headers: {
          ...bearer(c1Token),
          'idempotency-key': 'k1',
          'content-type': 'application/json',
        },
        payload,
      });

    const first = await withdrawWith('{"amount": "100", "currency": "EUR"}');
    expect(first.statusCode).toBe(201);
    const stored = await keyRowOf(c1, 'k1');
    expect(stored).toMatchObject({ status: 201 });
    expect(stored?.body?.equals(first.rawPayload)).toBe(true);

    const reused = [
      ['another amount', await withdrawWith('{"amount": "200", "currency": "EUR"}')],
      ['an invalid amount', await withdrawWith('{"amount": "abc", "currency": "EUR"}')],
    ] as const;
    for (const [name, response] of reused) {
      expect(response.statusCode, name).toBe(422);
      expect(problemOf(response).type, name).toBe('/problems/idempotency-key-reused');
      expect(await keyRowOf(c1, 'k1'), name).toEqual(stored);
    }
    const transferred = await transfer(built.app, c1Token, a1.id, b1.id, '100', { key: 'k1' });
    expect(transferred.statusCode).toBe(422);
    expect(problemOf(transferred).type).toBe('/problems/idempotency-key-reused');
    expect(await keyRowOf(c1, 'k1')).toEqual(stored);

    const reordered = await withdrawWith('{"currency":"EUR","amount":"100"}');
    expect(reordered.statusCode).toBe(201);
    expect(reordered.rawPayload.equals(first.rawPayload)).toBe(true);
    expect(reordered.headers['idempotent-replayed']).toBe('true');
    expect(await keyRowOf(c1, 'k1')).toEqual(stored);

    expect(await balanceOf(a1.id)).toBe('900');
    expect(await balanceOf(b1.id)).toBe('0');
    expect((await transactionsOn(a1.id))['withdrawal']).toBe(1);
    expect((await transactionsOn(a1.id))['transfer']).toBeUndefined();
  });
});
