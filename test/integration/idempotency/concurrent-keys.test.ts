import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { blockedBackends } from '../../support/backends.js';
import {
  balanceOf,
  closePools,
  createCustomerAccount,
  writeDirectDeposit,
} from '../../support/db.js';
import { problemOf, withdraw } from '../../support/http.js';
import { openLockSession, type LockSession } from '../../support/sessions.js';
import { buildTestApp, type BuiltTestApp } from '../../support/test-app.js';
import { tokenFor } from '../../support/tokens.js';
import { transactionsOfKind } from '../movements/support.js';

/** The settings both replicas start with in IDM-AC10 to IDM-AC12. */
const REPLICA_ENV = {
  IDEMPOTENCY_WAIT_TIMEOUT_MS: '3000',
  ACCOUNT_LOCK_TIMEOUT_MS: '4000',
  REQUEST_TIMEOUT_MS: '40000',
  SHUTDOWN_TIMEOUT_MS: '40000',
};

describe('one key on two replicas', () => {
  let p1: BuiltApp;
  let p2: BuiltApp;
  let faulty: BuiltTestApp;
  let session: LockSession;

  beforeAll(async () => {
    p1 = buildProductionApp({ env: REPLICA_ENV });
    p2 = buildProductionApp({ env: REPLICA_ENV });
    faulty = buildTestApp({ env: REPLICA_ENV });
    await Promise.all([p1.app.ready(), p2.app.ready(), faulty.app.ready()]);
    session = await openLockSession();
  });

  afterAll(async () => {
    await session.close();
    await Promise.all([p1.app.close(), p2.app.close(), faulty.app.close()]);
    await closePools();
  });

  /** A customer and an account of theirs holding `balance` EUR. */
  async function customerWith(balance: string) {
    const id = randomUUID();
    const account = await createCustomerAccount({ currency: 'EUR', ownerId: id });
    await writeDirectDeposit(account, balance);
    return { id, token: tokenFor(id, 'customer'), account };
  }

  /**
   * R1 on `first` waits on A1's row lock; once it does, R2 on `second` is sent and waits for R1;
   * once it does, the session releases A1. Resolves with both answers.
   */
  async function raced(
    first: () => Promise<LightMyRequestResponse>,
    second: () => Promise<LightMyRequestResponse>,
    accountId: string,
  ) {
    await session.lockRow('accounts', accountId);
    try {
      const answered: string[] = [];
      const r1 = first().then((response) => {
        answered.push('R1');
        return response;
      });
      const [r1Backend] = await blockedBackends({ count: 1, by: session.pid });
      if (r1Backend === undefined) throw new Error('R1 is not waiting');
      const r2 = second().then((response) => {
        answered.push('R2');
        return response;
      });
      await blockedBackends({ count: 1, by: r1Backend });
      await session.release();
      return { r1: await r1, r2: await r2, answered };
    } finally {
      await session.release();
    }
  }

  it('IDM-AC10 the same request with one key on two replicas executes once, and a burst of 20 on both executes once', async () => {
    const c1 = await customerWith('1000');
    const k1 = randomUUID();
    const { r1, r2 } = await raced(
      () => withdraw(p1.app, c1.token, c1.account.id, '100', { key: k1 }),
      () => withdraw(p2.app, c1.token, c1.account.id, '100', { key: k1 }),
      c1.account.id,
    );
    expect(r1.statusCode).toBe(201);
    expect(r1.headers).not.toHaveProperty('idempotent-replayed');
    expect(r2.statusCode).toBe(201);
    expect(r2.headers['idempotent-replayed']).toBe('true');
    expect(r2.rawPayload.equals(r1.rawPayload)).toBe(true);
    expect(await transactionsOfKind(c1.account.id, 'withdrawal')).toHaveLength(1);

    const a2 = await createCustomerAccount({ currency: 'EUR', ownerId: c1.id });
    await writeDirectDeposit(a2, '1000');
    const k2 = randomUUID();
    const burst = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        withdraw(i % 2 === 0 ? p1.app : p2.app, c1.token, a2.id, '100', { key: k2 }),
      ),
    );
    expect(burst.filter((response) => response.statusCode >= 500)).toEqual([]);
    expect(burst.every((response) => response.statusCode === 201)).toBe(true);
    const [reference] = burst;
    if (reference === undefined) throw new Error('no response');
    for (const response of burst)
      expect(response.rawPayload.equals(reference.rawPayload)).toBe(true);
    expect(
      burst.filter((response) => response.headers['idempotent-replayed'] === undefined),
    ).toHaveLength(1);
    expect(await transactionsOfKind(a2.id, 'withdrawal')).toHaveLength(1);
    expect(await balanceOf(a2.id)).toBe('900');
  });

  it('IDM-AC11 a request waiting for the key with another body gets 422 once the first finishes', async () => {
    const c1 = await customerWith('1000');
    const k1 = randomUUID();
    const { r1, r2, answered } = await raced(
      () => withdraw(p1.app, c1.token, c1.account.id, '100', { key: k1 }),
      () => withdraw(p2.app, c1.token, c1.account.id, '200', { key: k1 }),
      c1.account.id,
    );
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(422);
    expect(problemOf(r2).type).toBe('/problems/idempotency-key-reused');
    expect(answered).toEqual(['R1', 'R2']);
    expect(await balanceOf(c1.account.id)).toBe('900');
    expect(await transactionsOfKind(c1.account.id, 'withdrawal')).toHaveLength(1);
  });

  it('IDM-AC12 a request waiting for the key runs itself when the first rolls back', async () => {
    const c1 = await customerWith('1000');
    const k1 = randomUUID();
    faulty.faults.failAt('after-entries', new Error('fault after the ledger entries'));
    try {
      const { r1, r2 } = await raced(
        () => withdraw(faulty.app, c1.token, c1.account.id, '100', { key: k1 }),
        () => withdraw(p2.app, c1.token, c1.account.id, '100', { key: k1 }),
        c1.account.id,
      );
      expect(r1.statusCode).toBe(500);
      expect(problemOf(r1).type).toBe('/problems/internal-error');
      expect(r2.statusCode).toBe(201);
      expect(r2.headers).not.toHaveProperty('idempotent-replayed');
      const written = await transactionsOfKind(c1.account.id, 'withdrawal');
      expect(written).toEqual([r2.json<{ id: string }>().id]);
    } finally {
      faulty.faults.clear();
    }
    expect(await balanceOf(c1.account.id)).toBe('900');
  });
});
