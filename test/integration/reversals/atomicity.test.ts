import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { balanceOf, closePools } from '../../support/db.js';
import { createAccount, deposit, problemOf, reverse, transfer } from '../../support/http.js';
import { buildTestApp, type BuiltTestApp } from '../../support/test-app.js';
import { footprint, idOf, keyRowExists, reversalAuditsOf, reversalsOf, users } from './support.js';

describe('a reversal is all or nothing', () => {
  let built: BuiltTestApp;

  beforeAll(async () => {
    built = buildTestApp();
    await built.app.ready();
  });

  afterAll(async () => {
    built.faults.clear();
    await built.app.close();
    await closePools();
  });

  it('REV-AC19 a fault after the entries and balances leaves no trace of the reversal, and the repeat applies it once', async () => {
    const u = users();
    const a1 = await createAccount(built.app, u.c1);
    const b1 = await createAccount(built.app, u.c2);
    idOf(await deposit(built.app, u.o1, a1.id, '1000'));
    const t = idOf(await transfer(built.app, u.c1, a1.id, b1.id, '300'));
    const before = await footprint([a1.id, b1.id]);

    built.faults.failAt('after-balances', new Error('fault after the balance changes'));
    let failed;
    try {
      failed = await reverse(built.app, u.o1, t, { key: 'k1' });
    } finally {
      built.faults.clear();
    }

    expect(failed.statusCode, failed.body).toBe(500);
    expect(problemOf(failed).type).toBe('/problems/internal-error');
    expect(await footprint([a1.id, b1.id])).toEqual(before);
    expect(await keyRowExists(u.ids.o1, 'k1')).toBe(false);
    expect(await reversalsOf(t)).toEqual([]);
    expect(await reversalAuditsOf(t)).toEqual([]);
    expect(await balanceOf(a1.id)).toBe('700');
    expect(await balanceOf(b1.id)).toBe('300');

    const repeat = await reverse(built.app, u.o1, t, { key: 'k1' });

    expect(repeat.statusCode, repeat.body).toBe(201);
    expect(await balanceOf(a1.id)).toBe('1000');
    expect(await balanceOf(b1.id)).toBe('0');
    expect(await reversalsOf(t)).toHaveLength(1);
  });
});
