import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { buildProductionApp } from '../../support/app.js';
import { balanceOf, closePools } from '../../support/db.js';
import { createAccount, deposit, problemOf, transfer, withdraw } from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';
import { rowsTouching } from './api-support.js';

describe('the maximum amount', () => {
  afterAll(async () => {
    await closePools();
  });

  it('LED-AC18 with MAX_AMOUNT_MINOR unset, 100000000000 is accepted and 100000000001 answers 422 for amount on every movement, before the lookup', async () => {
    const built = buildProductionApp();
    try {
      const c1 = tokenFor(randomUUID(), 'customer');
      const c2 = tokenFor(randomUUID(), 'customer');
      const o1 = tokenFor(randomUUID(), 'operator');
      const a1 = await createAccount(built.app, c1, 'EUR');
      const b1 = await createAccount(built.app, c2, 'EUR');
      const u = randomUUID();

      const first = await deposit(built.app, o1, a1.id, '100000000000');
      expect(first.statusCode).toBe(201);
      expect(await balanceOf(a1.id)).toBe('100000000000');
      const before = await rowsTouching([a1.id, b1.id]);

      const refused = {
        'deposit into A1': await deposit(built.app, o1, a1.id, '100000000001'),
        'withdrawal from A1': await withdraw(built.app, c1, a1.id, '100000000001'),
        'transfer from A1 to B1': await transfer(built.app, c1, a1.id, b1.id, '100000000001'),
        'deposit into U': await deposit(built.app, o1, u, '100000000001'),
      };
      for (const [name, response] of Object.entries(refused)) {
        expect(response.statusCode, name).toBe(422);
        const body = problemOf(response);
        expect(body.type, name).toBe('/problems/validation-error');
        expect(body['errors'], name).toEqual([
          { pointer: '/amount', detail: expect.any(String) as unknown },
        ]);
      }

      expect(await rowsTouching([a1.id, b1.id])).toEqual(before);
      expect(await rowsTouching([u])).toEqual({ transactions: '0', entries: '0', audits: '0' });
      expect(await balanceOf(a1.id)).toBe('100000000000');
      expect(await balanceOf(b1.id)).toBe('0');
    } finally {
      await built.app.close();
    }
  });

  it('LED-AC19 with MAX_AMOUNT_MINOR "500", a deposit of "500" JPY succeeds and "501" JPY answers 422 for amount', async () => {
    const built = buildProductionApp({ env: { MAX_AMOUNT_MINOR: '500' } });
    try {
      const c1 = tokenFor(randomUUID(), 'customer');
      const o1 = tokenFor(randomUUID(), 'operator');
      const j1 = await createAccount(built.app, c1, 'JPY');

      const first = await deposit(built.app, o1, j1.id, '500', { currency: 'JPY' });
      expect(first.statusCode).toBe(201);

      const second = await deposit(built.app, o1, j1.id, '501', { currency: 'JPY' });
      expect(second.statusCode).toBe(422);
      const body = problemOf(second);
      expect(body.type).toBe('/problems/validation-error');
      expect(body['errors']).toEqual([
        { pointer: '/amount', detail: expect.any(String) as unknown },
      ]);

      expect(await balanceOf(j1.id)).toBe('500');
    } finally {
      await built.app.close();
    }
  });
});
