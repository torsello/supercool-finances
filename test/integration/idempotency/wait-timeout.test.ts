import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { blockedBackends, blockersOf } from '../../support/backends.js';
import {
  balanceOf,
  closePools,
  createCustomerAccount,
  writeDirectDeposit,
} from '../../support/db.js';
import { problemOf, withdraw } from '../../support/http.js';
import { openLockSession, type LockSession } from '../../support/sessions.js';
import { tokenFor } from '../../support/tokens.js';
import { transactionsOfKind } from '../movements/support.js';

describe('the idempotency wait timeout', () => {
  let built: BuiltApp;
  let session: LockSession;

  beforeAll(async () => {
    built = buildProductionApp({
      env: {
        IDEMPOTENCY_WAIT_TIMEOUT_MS: '300',
        ACCOUNT_LOCK_TIMEOUT_MS: '4000',
        REQUEST_TIMEOUT_MS: '30000',
        SHUTDOWN_TIMEOUT_MS: '30000',
      },
    });
    await built.app.ready();
    session = await openLockSession();
  });

  afterAll(async () => {
    await session.close();
    await built.app.close();
    await closePools();
  });

  it('IDM-AC13 a request that waits for the key longer than the wait timeout answers 409 while the first goes on', async () => {
    const c1Id = randomUUID();
    const c1 = tokenFor(c1Id, 'customer');
    const a1 = await createCustomerAccount({ currency: 'EUR', ownerId: c1Id });
    await writeDirectDeposit(a1, '1000');
    const k1 = randomUUID();

    await session.lockRow('accounts', a1.id);
    let r1Answered = false;
    const r1 = withdraw(built.app, c1, a1.id, '100', { key: k1 }).then((response) => {
      r1Answered = true;
      return response;
    });
    try {
      const [r1Backend] = await blockedBackends({ count: 1, by: session.pid });
      if (r1Backend === undefined) throw new Error('R1 is not waiting');

      const started = performance.now();
      const r2 = withdraw(built.app, c1, a1.id, '100', { key: k1 });
      const [r2Backend] = await blockedBackends({ count: 1, by: r1Backend });
      if (r2Backend === undefined) throw new Error('R2 is not waiting');
      expect(await blockersOf(r2Backend)).toEqual([r1Backend]);
      const second = await r2;
      const elapsed = performance.now() - started;

      expect(second.statusCode).toBe(409);
      expect(problemOf(second).type).toBe('/problems/request-in-progress');
      expect(second.headers['retry-after']).toBe('1');
      expect(elapsed).toBeGreaterThanOrEqual(300);
      expect(r1Answered).toBe(false);
    } finally {
      await session.release();
    }

    const first = await r1;
    expect(first.statusCode).toBe(201);
    const third = await withdraw(built.app, c1, a1.id, '100', { key: k1 });
    expect(third.statusCode).toBe(201);
    expect(third.headers['idempotent-replayed']).toBe('true');
    expect(third.rawPayload.equals(first.rawPayload)).toBe(true);
    expect(await balanceOf(a1.id)).toBe('900');
    expect(await transactionsOfKind(a1.id, 'withdrawal')).toHaveLength(1);
  });
});
