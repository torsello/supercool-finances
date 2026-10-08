import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { balanceOf, closePools } from '../../support/db.js';
import { createAccount, deposit, problemOf, reverse, transfer } from '../../support/http.js';
import { idOf, reconciliation, users } from './support.js';

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
});
