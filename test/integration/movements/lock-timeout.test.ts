import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import {
  balanceOf,
  closePools,
  createCustomerAccount,
  writeDirectDeposit,
} from '../../support/db.js';
import {
  createAccount,
  deposit,
  problemOf,
  transfer,
  withdraw,
  type MovementJson,
} from '../../support/http.js';
import { blockedBackends, blockersOf } from '../../support/backends.js';
import { openLockSession, type LockSession } from '../../support/sessions.js';
import { tokenFor } from '../../support/tokens.js';
import {
  auditsOn,
  auditsWithRequestId,
  entriesOn,
  keyRecord,
  transactionsOfKind,
  transactionsOn,
} from './support.js';

describe('the account lock timeout', () => {
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

  /** Runs a request and measures how long it took to answer, in milliseconds. */
  async function timed(
    request: () => Promise<LightMyRequestResponse>,
  ): Promise<[LightMyRequestResponse, number]> {
    const started = performance.now();
    const response = await request();
    return [response, performance.now() - started];
  }

  it('MOV-AC12 a withdrawal and a transfer that wait for a held account lock answer 503 in time, write nothing, and the key is free for a retry', async () => {
    const c1Id = randomUUID();
    const c2Id = randomUUID();
    const c1 = tokenFor(c1Id, 'customer');
    const c2 = tokenFor(c2Id, 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, c1, 'EUR');
    const b1 = await createAccount(built.app, c2, 'EUR');
    expect((await deposit(built.app, o1, a1.id, '1000')).statusCode).toBe(201);
    const k1 = randomUUID();
    const k2 = randomUUID();

    await session.lockRow('accounts', a1.id);
    const transactionsBefore = await transactionsOn(a1.id, b1.id);
    const entriesBefore = await entriesOn(a1.id, b1.id);
    const auditsBefore = await auditsOn(a1.id, b1.id);
    let withdrawal: [LightMyRequestResponse, number];
    let transferred: [LightMyRequestResponse, number];
    try {
      withdrawal = await timed(() => withdraw(built.app, c1, a1.id, '100', { key: k1 }));
      expect((await deposit(built.app, o1, b1.id, '500')).statusCode).toBe(201);
      transferred = await timed(() => transfer(built.app, c2, b1.id, a1.id, '100', { key: k2 }));
    } finally {
      await session.release();
    }

    for (const [response, elapsed] of [withdrawal, transferred]) {
      expect(response.statusCode).toBe(503);
      expect(problemOf(response).type).toBe('/problems/service-unavailable');
      expect(response.headers['retry-after']).toBe('1');
      expect(elapsed).toBeGreaterThanOrEqual(200);
      expect(elapsed).toBeLessThan(5000);
    }
    expect(await keyRecord(c1Id, k1)).toBeUndefined();
    expect(await keyRecord(c2Id, k2)).toBeUndefined();
    // Only the deposit into B1 was added while the lock was held: one transaction, two entries
    // (one on B1) and one audit record.
    expect(await transactionsOn(a1.id, b1.id)).toBe(transactionsBefore + 1);
    expect(await entriesOn(a1.id, b1.id)).toBe(entriesBefore + 1);
    expect(await auditsOn(a1.id, b1.id)).toBe(auditsBefore + 1);
    expect(await transactionsOfKind(a1.id, 'withdrawal')).toEqual([]);
    expect(await transactionsOfKind(a1.id, 'transfer')).toEqual([]);
    expect(await balanceOf(a1.id)).toBe('1000');
    expect(await balanceOf(b1.id)).toBe('500');

    const repeated = await withdraw(built.app, c1, a1.id, '100', { key: k1 });
    expect(repeated.statusCode).toBe(201);
    const body = repeated.json<MovementJson>();
    expect(body.balance).toBe('900');
    expect(await transactionsOfKind(a1.id, 'withdrawal')).toEqual([body.id]);
    expect((await keyRecord(c1Id, k1))?.body?.['id']).toBe(body.id);
  });
});

describe('the idempotency wait and the account lock timeout', () => {
  let built: BuiltApp;
  let session: LockSession;

  beforeAll(async () => {
    built = buildProductionApp({
      env: {
        ACCOUNT_LOCK_TIMEOUT_MS: '4000',
        IDEMPOTENCY_WAIT_TIMEOUT_MS: '300',
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

  it('MOV-AC19 a second request with the key waits for the first, not for the account lock, and answers 409 before the first answers 503', async () => {
    const c1Id = randomUUID();
    const c1 = tokenFor(c1Id, 'customer');
    const a1 = await createCustomerAccount({ currency: 'EUR', ownerId: c1Id });
    await writeDirectDeposit(a1, '1000');
    const k1 = randomUUID();
    const send = async (requestId: string) =>
      await built.app.inject({
        method: 'POST',
        url: `/v1/accounts/${a1.id}/withdrawals`,
        headers: {
          authorization: `Bearer ${c1}`,
          'idempotency-key': k1,
          'x-request-id': requestId,
        },
        payload: { amount: '100', currency: 'EUR' },
      });

    await session.lockRow('accounts', a1.id);
    try {
      let r1Answered = false;
      const r1 = send('mov-ac19-r1').then((response) => {
        r1Answered = true;
        return response;
      });
      const [r1Backend] = await blockedBackends({ count: 1, by: session.pid });
      if (r1Backend === undefined) throw new Error('R1 is not waiting');

      const r2 = send('mov-ac19-r2');
      const [r2Backend] = await blockedBackends({ count: 1, by: r1Backend });
      if (r2Backend === undefined) throw new Error('R2 is not waiting');
      expect(await blockersOf(r2Backend)).toEqual([r1Backend]);

      const second = await r2;
      expect(r1Answered).toBe(false);
      expect(second.statusCode).toBe(409);
      expect(problemOf(second).type).toBe('/problems/request-in-progress');

      const first = await r1;
      expect(first.statusCode).toBe(503);
      expect(problemOf(first).type).toBe('/problems/service-unavailable');
      expect(first.headers['retry-after']).toBe('1');
    } finally {
      await session.release();
    }

    expect(await balanceOf(a1.id)).toBe('1000');
    expect(await transactionsOfKind(a1.id, 'withdrawal')).toEqual([]);
    expect(await entriesOn(a1.id)).toBe(1);
    expect(await keyRecord(c1Id, k1)).toBeUndefined();
    expect(await auditsWithRequestId('mov-ac19-r1')).toEqual([]);
    expect(await auditsWithRequestId('mov-ac19-r2')).toEqual([]);
  });
});
