import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { balanceOf, closePools } from '../../support/db.js';
import { createAccount, deposit, problemOf, transfer, withdraw } from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';
import { transactionsOn } from './support.js';

describe('the scope of a key', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('IDM-AC05 keys are scoped per user, compared exactly and shared across endpoints', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const c2 = tokenFor(randomUUID(), 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, c1, 'EUR');
    const b1 = await createAccount(built.app, c2, 'EUR');
    await deposit(built.app, o1, a1.id, '1000');
    await deposit(built.app, o1, b1.id, '1000');

    const withdrawals = [
      await withdraw(built.app, c1, a1.id, '100', { key: 'k1' }),
      await withdraw(built.app, c2, b1.id, '100', { key: 'k1' }),
      await withdraw(built.app, c2, b1.id, '100', { key: 'K1' }),
    ];
    for (const [index, response] of withdrawals.entries()) {
      expect(response.statusCode, String(index)).toBe(201);
      expect(response.headers['idempotent-replayed'], String(index)).toBeUndefined();
    }
    expect((await transactionsOn(a1.id))['withdrawal']).toBe(1);
    expect((await transactionsOn(b1.id))['withdrawal']).toBe(2);

    const transferred = await transfer(built.app, c1, a1.id, b1.id, '100', { key: 'k1' });
    expect(transferred.statusCode).toBe(422);
    expect(problemOf(transferred).type).toBe('/problems/idempotency-key-reused');

    expect(await balanceOf(a1.id)).toBe('900');
    expect(await balanceOf(b1.id)).toBe('800');
    expect((await transactionsOn(a1.id))['transfer']).toBeUndefined();
  });
});
