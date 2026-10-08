import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { balanceOf, closePools } from '../../support/db.js';
import {
  createAccount,
  deposit,
  problemOf,
  transfer,
  withdraw,
  type MovementJson,
} from '../../support/http.js';
import { openLockSession, type LockSession } from '../../support/sessions.js';
import { tokenFor } from '../../support/tokens.js';
import { auditsOn, entriesOn, keyRecord, transactionsOfKind, transactionsOn } from './support.js';

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
