import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { balanceOf, closePools } from '../../support/db.js';
import { createAccount, deposit, problemOf, withdraw } from '../../support/http.js';
import { buildTestApp } from '../../support/test-app.js';
import { tokenFor } from '../../support/tokens.js';
import { auditsOn, keyRowOf, transactionsOn } from './support.js';

/** A database error with SQLSTATE `code`, as the driver raises it. */
function databaseError(code: string): pg.DatabaseError {
  const error = new pg.DatabaseError(`injected ${code}`, 0, 'error');
  error.code = code;
  return error;
}

describe('outcomes that are not stored', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('IDM-AC18 a validation error is not stored, so the key then runs a valid request', async () => {
    const c1 = randomUUID();
    const c1Token = tokenFor(c1, 'customer');
    const a1 = await createAccount(built.app, c1Token, 'EUR');
    await deposit(built.app, tokenFor(randomUUID(), 'operator'), a1.id, '1000');

    const invalid = await withdraw(built.app, c1Token, a1.id, '10.50', { key: 'k1' });
    expect(invalid.statusCode).toBe(422);
    expect(problemOf(invalid).type).toBe('/problems/validation-error');
    expect(await keyRowOf(c1, 'k1')).toBeUndefined();

    const valid = await withdraw(built.app, c1Token, a1.id, '100', { key: 'k1' });
    expect(valid.statusCode).toBe(201);
    expect(valid.headers['idempotent-replayed']).toBeUndefined();
    expect(await balanceOf(a1.id)).toBe('900');
  });

  it('IDM-AC19 a 500 and a 503 after the retries are not stored, and a retry of each executes again', async () => {
    const c1 = randomUUID();
    const c1Token = tokenFor(c1, 'customer');
    const testApp = buildTestApp();
    try {
      await testApp.app.ready();
      const a1 = await createAccount(testApp.app, c1Token, 'EUR');
      await deposit(testApp.app, tokenFor(randomUUID(), 'operator'), a1.id, '1000');
      const audits = await auditsOn(a1.id);
      const expectNothingStoredFor = async (key: string) => {
        expect(await keyRowOf(c1, key), key).toBeUndefined();
        expect(await transactionsOn(a1.id), key).toEqual({ deposit: 1 });
        expect(await auditsOn(a1.id), key).toEqual(audits);
        expect(await balanceOf(a1.id), key).toBe('1000');
      };

      testApp.faults.failAt('after-entries', new Error('fault after the ledger entries'));
      const failed = await withdraw(testApp.app, c1Token, a1.id, '100', { key: 'k1' });
      expect(failed.statusCode).toBe(500);
      expect(problemOf(failed).type).toBe('/problems/internal-error');
      await expectNothingStoredFor('k1');

      testApp.faults.failAt('after-entries', databaseError('40001'));
      const attempts = vi.spyOn(testApp.faults, 'atStep');
      const exhausted = await withdraw(testApp.app, c1Token, a1.id, '100', { key: 'k2' });
      expect(attempts.mock.calls.filter(([step]) => step === 'after-entries')).toHaveLength(3);
      attempts.mockRestore();
      expect(exhausted.statusCode).toBe(503);
      expect(problemOf(exhausted).type).toBe('/problems/service-unavailable');
      await expectNothingStoredFor('k2');

      testApp.faults.clear();
      for (const key of ['k1', 'k2']) {
        const retry = await withdraw(testApp.app, c1Token, a1.id, '100', { key });
        expect(retry.statusCode, key).toBe(201);
        expect(retry.headers['idempotent-replayed'], key).toBeUndefined();
      }
      expect(await balanceOf(a1.id)).toBe('800');
      expect((await transactionsOn(a1.id))['withdrawal']).toBe(2);
      expect((await keyRowOf(c1, 'k1'))?.status).toBe(201);
      expect((await keyRowOf(c1, 'k2'))?.status).toBe(201);
    } finally {
      testApp.faults.clear();
      await testApp.app.close();
    }
  });
});
