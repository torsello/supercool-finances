import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { balanceOf, closePools } from '../../support/db.js';
import { createAccount, deposit, problemOf, reverse, transfer } from '../../support/http.js';
import { idOf, reconciliation, reversalsOf, users } from './support.js';

describe('a reversal racing a transfer', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('REV-AC22 a reversal and a transfer out of the same account at the same time never overdraw it, in 20 runs', async () => {
    const outcomes = new Set<string>();
    for (let run = 0; run < 20; run++) {
      const u = users();
      const a1 = await createAccount(built.app, u.c1);
      const b1 = await createAccount(built.app, u.c2);
      idOf(await deposit(built.app, u.o1, a1.id, '5000'));
      const t = idOf(await transfer(built.app, u.c1, a1.id, b1.id, '1000'));

      const [reversal, back] = await Promise.all([
        reverse(built.app, u.o1, t),
        transfer(built.app, u.c2, b1.id, a1.id, '600'),
      ]);

      const label = `run ${String(run)}`;
      expect(reversal.statusCode, label).toBeLessThan(500);
      expect(back.statusCode, label).toBeLessThan(500);
      const balances = [await balanceOf(a1.id), await balanceOf(b1.id)];
      if (reversal.statusCode === 201) {
        expect(back.statusCode, `${label}: ${back.body}`).toBe(422);
        expect(problemOf(back).type, label).toBe('/problems/insufficient-funds');
        expect(balances, label).toEqual(['5000', '0']);
        outcomes.add('reversal first');
      } else {
        expect(back.statusCode, `${label}: ${back.body}`).toBe(201);
        expect(reversal.statusCode, `${label}: ${reversal.body}`).toBe(422);
        expect(problemOf(reversal).type, label).toBe('/problems/insufficient-funds-for-reversal');
        expect(balances, label).toEqual(['4600', '400']);
        outcomes.add('transfer first');
      }
    }
    expect(outcomes.size).toBeGreaterThan(0);
    const reconciled = await reconciliation();
    expect(reconciled.report.discrepancies).toEqual([]);
    expect(reconciled.exitCode).toBe(0);
  });

  it('REV-AC23 reversals and crossed transfers at the same time never deadlock: all 120 answer 201', async () => {
    const burst = buildProductionApp({
      env: {
        DB_POOL_ACQUIRE_TIMEOUT_MS: '10000',
        REQUEST_TIMEOUT_MS: '30000',
        SHUTDOWN_TIMEOUT_MS: '30000',
      },
    });
    try {
      await burst.app.ready();
      const u = users();
      const a1 = await createAccount(burst.app, u.c1);
      const b1 = await createAccount(burst.app, u.c2);
      idOf(await deposit(burst.app, u.o1, a1.id, '100000'));
      idOf(await deposit(burst.app, u.o1, b1.id, '100000'));
      const originals: string[] = [];
      for (let i = 0; i < 20; i += 1) {
        originals.push(idOf(await transfer(burst.app, u.c1, a1.id, b1.id, '100')));
      }
      expect([await balanceOf(a1.id), await balanceOf(b1.id)]).toEqual(['98000', '102000']);

      const responses = await Promise.all([
        ...originals.map((id) => reverse(burst.app, u.o1, id)),
        ...Array.from({ length: 50 }, () => transfer(burst.app, u.c1, a1.id, b1.id, '1000')),
        ...Array.from({ length: 50 }, () => transfer(burst.app, u.c2, b1.id, a1.id, '1000')),
      ]);

      expect(responses).toHaveLength(120);
      expect(responses.filter((response) => response.statusCode >= 500)).toEqual([]);
      expect(responses.every((response) => response.statusCode === 201)).toBe(true);
      expect([await balanceOf(a1.id), await balanceOf(b1.id)]).toEqual(['100000', '100000']);
      for (const id of originals) expect(await reversalsOf(id)).toHaveLength(1);
      const reconciled = await reconciliation();
      expect(reconciled.report.discrepancies).toEqual([]);
      expect(reconciled.exitCode).toBe(0);
    } finally {
      await burst.app.close();
    }
  });
});
