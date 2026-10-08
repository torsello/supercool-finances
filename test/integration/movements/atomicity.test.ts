import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { balanceOf, closePools } from '../../support/db.js';
import {
  createAccount,
  deposit,
  problemOf,
  transfer,
  type MovementJson,
} from '../../support/http.js';
import { buildTestApp, type BuiltTestApp } from '../../support/test-app.js';
import { tokenFor } from '../../support/tokens.js';
import { auditsOn, entriesOn, keyRecord, transactionsOfKind, transactionsOn } from './support.js';

describe('a movement is all or nothing', () => {
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

  it('MOV-AC17 a transfer that fails after its entries and balance changes leaves no trace, and the same key then applies it once', async () => {
    const c1Id = randomUUID();
    const c1 = tokenFor(c1Id, 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, c1, 'EUR');
    const b1 = await createAccount(built.app, tokenFor(randomUUID(), 'customer'), 'EUR');
    expect((await deposit(built.app, o1, a1.id, '1000')).statusCode).toBe(201);
    const transactionsBefore = await transactionsOn(a1.id, b1.id);
    const entriesBefore = await entriesOn(a1.id, b1.id);
    const auditsBefore = await auditsOn(a1.id, b1.id);
    const k1 = randomUUID();

    built.faults.failAt('after-balances', new Error('fault after the balance changes'));
    let failed: Awaited<ReturnType<typeof transfer>>;
    try {
      failed = await transfer(built.app, c1, a1.id, b1.id, '300', { key: k1 });
    } finally {
      built.faults.clear();
    }

    expect(failed.statusCode).toBe(500);
    expect(problemOf(failed).type).toBe('/problems/internal-error');
    expect(await keyRecord(c1Id, k1)).toBeUndefined();
    expect(await transactionsOn(a1.id, b1.id)).toBe(transactionsBefore);
    expect(await entriesOn(a1.id, b1.id)).toBe(entriesBefore);
    expect(await auditsOn(a1.id, b1.id)).toBe(auditsBefore);
    expect(await balanceOf(a1.id)).toBe('1000');
    expect(await balanceOf(b1.id)).toBe('0');

    const repeated = await transfer(built.app, c1, a1.id, b1.id, '300', { key: k1 });
    expect(repeated.statusCode).toBe(201);
    const id = repeated.json<MovementJson>().id;
    expect(await balanceOf(a1.id)).toBe('700');
    expect(await balanceOf(b1.id)).toBe('300');
    expect(await transactionsOfKind(a1.id, 'transfer')).toEqual([id]);
    expect((await keyRecord(c1Id, k1))?.body?.['id']).toBe(id);
  });
});
