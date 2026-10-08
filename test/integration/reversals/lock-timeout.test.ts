import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { balanceOf, closePools } from '../../support/db.js';
import { createAccount, deposit, problemOf, reverse } from '../../support/http.js';
import { openLockSession, type LockSession } from '../../support/sessions.js';
import { footprint, idOf, keyRowExists, reversalAuditsOf, reversalsOf, users } from './support.js';

describe('an account lock not acquired in time', () => {
  let built: BuiltApp;
  let session: LockSession;

  beforeAll(async () => {
    built = buildProductionApp({ env: { ACCOUNT_LOCK_TIMEOUT_MS: '200' } });
    await built.app.ready();
    session = await openLockSession();
  });

  afterAll(async () => {
    await session.close();
    await built.app.close();
    await closePools();
  });

  it('REV-AC21 a reversal that waits longer than ACCOUNT_LOCK_TIMEOUT_MS answers 503, leaves no trace and can be repeated', async () => {
    const u = users();
    const a1 = await createAccount(built.app, u.c1);
    const d = idOf(await deposit(built.app, u.o1, a1.id, '1000'));
    const before = await footprint([a1.id]);

    await session.lockRow('accounts', a1.id);
    let timedOut;
    let elapsed: number;
    try {
      const started = performance.now();
      timedOut = await reverse(built.app, u.o1, d, { key: 'k1' });
      elapsed = performance.now() - started;
    } finally {
      await session.release();
    }

    expect(timedOut.statusCode, timedOut.body).toBe(503);
    expect(problemOf(timedOut).type).toBe('/problems/service-unavailable');
    expect(timedOut.headers['retry-after']).toBe('1');
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(5000);
    expect(await footprint([a1.id])).toEqual(before);
    expect(await keyRowExists(u.ids.o1, 'k1')).toBe(false);
    expect(await reversalsOf(d)).toEqual([]);
    expect(await reversalAuditsOf(d)).toEqual([]);
    expect(await balanceOf(a1.id)).toBe('1000');

    const repeat = await reverse(built.app, u.o1, d, { key: 'k1' });

    expect(repeat.statusCode, repeat.body).toBe(201);
    expect(await balanceOf(a1.id)).toBe('0');
    expect(await reversalsOf(d)).toHaveLength(1);
  });
});
