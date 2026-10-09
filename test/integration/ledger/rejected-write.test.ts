import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { balanceOf, closePools, runtimePool, settlementAccountId } from '../../support/db.js';
import { createAccount, deposit, problemOf } from '../../support/http.js';
import { LOG_LEVEL } from '../../support/logs.js';
import { buildTestApp, type BuiltTestApp } from '../../support/test-app.js';
import { tokenFor } from '../../support/tokens.js';
import { rowsTouching } from './api-support.js';

describe('a ledger write the database rejects (LED-R28)', () => {
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

  it('LED-AC23 answers 500, applies nothing and logs the rejection with its SQLSTATE', async () => {
    const o1Id = randomUUID();
    const o1 = tokenFor(o1Id, 'operator');
    const a1 = await createAccount(built.app, tokenFor(randomUUID(), 'customer'));
    expect((await deposit(built.app, o1, a1.id, '1000')).statusCode).toBe(201);
    const s = await settlementAccountId('EUR');
    const before = await rowsTouching([a1.id]);
    const k1 = randomUUID();

    built.faults.rewriteEntry(s, -99n);
    built.logs.clear();
    let response;
    try {
      response = await built.app.inject({
        method: 'POST',
        url: `/v1/accounts/${a1.id}/deposits`,
        headers: {
          authorization: `Bearer ${o1}`,
          'idempotency-key': k1,
          'x-request-id': 'req-led',
        },
        payload: { amount: '100', currency: 'EUR' },
      });
    } finally {
      built.faults.clear();
    }

    expect(response.statusCode).toBe(500);
    expect(problemOf(response).type).toBe('/problems/internal-error');
    expect(await balanceOf(a1.id)).toBe('1000');
    expect(await rowsTouching([a1.id])).toEqual(before);
    const keys = await runtimePool().query(
      'SELECT 1 FROM idempotency_keys WHERE user_id = $1 AND key = $2',
      [o1Id, k1],
    );
    expect(keys.rows).toEqual([]);
    const audits = await runtimePool().query(
      `SELECT 1 FROM audit_records WHERE request_id = 'req-led' AND actor_id = $1`,
      [o1Id],
    );
    expect(audits.rows).toEqual([]);

    const errors = built.logs
      .linesOf('req-led')
      .filter((line) => (line.level ?? 0) === LOG_LEVEL.error);
    expect(errors).toHaveLength(1);
    // The deferred balance check of LED-R04 rejected the commit: check_violation.
    expect(errors[0]?.['sqlstate']).toBe('23514');
    expect(errors[0]?.['constraint']).toBe('ledger_transaction_balanced');
  });
});
