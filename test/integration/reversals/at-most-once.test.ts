import { randomUUID } from 'node:crypto';
import type { DatabaseError } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { balanceOf, closePools, runtimePool, settlementAccountId } from '../../support/db.js';
import { createAccount, deposit, problemOf, reverse } from '../../support/http.js';
import { buildTestApp, type BuiltTestApp } from '../../support/test-app.js';
import {
  footprint,
  idOf,
  reconciliation,
  reversalAuditsOf,
  reversalsOf,
  users,
} from './support.js';

describe('a transaction is reversed at most once', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('REV-AC06 a second reversal answers 409, and a second reversal written directly is refused by the unique constraint', async () => {
    const u = users();
    const a1 = await createAccount(built.app, u.c1);
    const d = idOf(await deposit(built.app, u.o1, a1.id, '1000'));
    const r1 = idOf(await reverse(built.app, u.o1, d, { key: 'k1' }));
    idOf(await deposit(built.app, u.o1, a1.id, '1000'));
    expect(await balanceOf(a1.id)).toBe('1000');
    const before = await footprint([a1.id]);

    const again = await reverse(built.app, u.o1, d, { key: 'k2' });

    expect(again.statusCode, again.body).toBe(409);
    expect(problemOf(again).type).toBe('/problems/already-reversed');
    expect(await footprint([a1.id])).toEqual(before);

    const s = await settlementAccountId('EUR');
    const directId = randomUUID();
    const client = await runtimePool().connect();
    let refusal: DatabaseError | undefined;
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO transactions (id, kind, currency, reversed_transaction_id)
         VALUES ($1, 'reversal', 'EUR', $2)`,
        [directId, d],
      );
      await client.query(
        `INSERT INTO ledger_entries (id, transaction_id, account_id, amount, currency)
         VALUES ($1, $3, $4, -1000, 'EUR'), ($2, $3, $5, 1000, 'EUR')`,
        [randomUUID(), randomUUID(), directId, a1.id, s],
      );
      await client.query('UPDATE accounts SET balance = balance - 1000 WHERE id = $1', [a1.id]);
      await client.query('COMMIT');
    } catch (error) {
      refusal = error as DatabaseError;
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(refusal?.code).toBe('23505');
    expect(refusal?.constraint).toBe('transactions_reversed_transaction_id_key');
    const stored = await runtimePool().query(
      `SELECT 1 FROM transactions WHERE id = $1
       UNION ALL SELECT 1 FROM ledger_entries WHERE transaction_id = $1`,
      [directId],
    );
    expect(stored.rowCount).toBe(0);

    expect(await balanceOf(a1.id)).toBe('1000');
    expect(await reversalsOf(d)).toEqual([r1]);
    expect(await footprint([a1.id])).toEqual(before);
    const audits = await reversalAuditsOf(d);
    expect(audits.map((audit) => audit.transaction_id)).toEqual([r1]);
  });

  it('REV-AC07 of ten concurrent reversals of one transaction exactly one applies and nine answer 409', async () => {
    const u = users();
    const a1 = await createAccount(built.app, u.c1);
    const d = idOf(await deposit(built.app, u.o1, a1.id, '1000'));

    const responses = await Promise.all(
      Array.from({ length: 10 }, async () => await reverse(built.app, u.o1, d)),
    );

    const statuses = responses.map((response) => response.statusCode);
    expect(statuses.filter((status) => status >= 500)).toEqual([]);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    const conflicts = responses.filter((response) => response.statusCode === 409);
    expect(conflicts).toHaveLength(9);
    for (const response of conflicts) {
      expect(problemOf(response).type).toBe('/problems/already-reversed');
    }
    expect(await balanceOf(a1.id)).toBe('0');
    expect(await reversalsOf(d)).toHaveLength(1);
    expect(await reversalAuditsOf(d)).toHaveLength(1);
    const reconciled = await reconciliation();
    expect(reconciled.report.discrepancies).toEqual([]);
    expect(reconciled.exitCode).toBe(0);
  });

  it('REV-AC09 a reversal cannot be reversed', async () => {
    const u = users();
    const a1 = await createAccount(built.app, u.c1);
    const d = idOf(await deposit(built.app, u.o1, a1.id, '1000'));
    const r = idOf(await reverse(built.app, u.o1, d));
    const before = await footprint([a1.id]);

    const response = await reverse(built.app, u.o1, r);

    expect(response.statusCode, response.body).toBe(422);
    expect(problemOf(response).type).toBe('/problems/transaction-not-reversible');
    expect(await balanceOf(a1.id)).toBe('0');
    expect(await reversalsOf(r)).toEqual([]);
    expect(await footprint([a1.id])).toEqual(before);
  });
});

describe('a reversal refused by the unique constraint', () => {
  let built: BuiltTestApp;

  beforeAll(async () => {
    built = buildTestApp();
    await built.app.ready();
  });

  afterAll(async () => {
    built.reversalCheck.disable();
    await built.app.close();
    await closePools();
  });

  it('REV-AC08 with the check for an existing reversal skipped, the unique constraint refuses the insert and the answer is still 409', async () => {
    const u = users();
    const a1 = await createAccount(built.app, u.c1);
    const d = idOf(await deposit(built.app, u.o1, a1.id, '1000'));
    idOf(await deposit(built.app, u.o1, a1.id, '1000'));
    idOf(await reverse(built.app, u.o1, d));
    expect(await balanceOf(a1.id)).toBe('1000');
    const before = await footprint([a1.id]);
    const skippedBefore = built.reversalCheck.skipped.length;
    const refusedBefore = built.reversalCheck.refused.length;

    built.reversalCheck.enable();
    let response;
    try {
      response = await reverse(built.app, u.o1, d, { key: 'k2' });
    } finally {
      built.reversalCheck.disable();
    }

    expect(built.reversalCheck.skipped.slice(skippedBefore)).toEqual([d]);
    expect(built.reversalCheck.refused.slice(refusedBefore)).toEqual([
      { sqlstate: '23505', constraint: 'transactions_reversed_transaction_id_key' },
    ]);
    expect(response.statusCode, response.body).toBe(409);
    expect(problemOf(response).type).toBe('/problems/already-reversed');
    expect(await balanceOf(a1.id)).toBe('1000');
    expect(await reversalsOf(d)).toHaveLength(1);
    expect(await reversalAuditsOf(d)).toHaveLength(1);
    expect(await footprint([a1.id])).toEqual(before);
  });
});
