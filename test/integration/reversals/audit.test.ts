import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { balanceOf, closePools } from '../../support/db.js';
import { createAccount, deposit, problemOf, transfer } from '../../support/http.js';
import { idOf, readTransaction, reversalAuditsOf, reverseWith, users } from './support.js';

const FRAUD = 'Fraud ticket #4411: card testing';
const VALID = { reason: 'Operator correction' };

describe('the audit record of a reversal', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('REV-AC18 each reversal writes one audit record with its exact reason, which no response or log line shows', async () => {
    const u = users();
    const a1 = await createAccount(built.app, u.c1);
    const b1 = await createAccount(built.app, u.c2);
    const d = idOf(await deposit(built.app, u.o1, a1.id, '1000'));
    const t = idOf(await transfer(built.app, u.c1, a1.id, b1.id, '300'));
    built.logs.clear();

    const k1 = await reverseWith(
      built.app,
      u.o1,
      t,
      { reason: FRAUD },
      { 'idempotency-key': 'k1', 'x-request-id': 'req-rev' },
    );
    const k1Logs = built.logs.linesOf('req-rev');
    const k2 = await reverseWith(built.app, u.o1, t, VALID, { 'idempotency-key': 'k2' });
    const k3 = await reverseWith(built.app, u.o1, d, VALID, { 'idempotency-key': 'k3' });
    const k4 = await reverseWith(built.app, u.o1, d, VALID, { 'idempotency-key': 'k4' });

    const reversalOfT = idOf(k1);
    const reversalOfD = idOf(k3);
    expect(await balanceOf(a1.id)).toBe('0');
    for (const conflict of [k2, k4]) {
      expect(conflict.statusCode, conflict.body).toBe(409);
      expect(problemOf(conflict).type).toBe('/problems/already-reversed');
    }
    const read = await readTransaction(built.app, u.c1, reversalOfT);
    expect(read.statusCode, read.body).toBe(200);

    const auditsOfT = await reversalAuditsOf(t);
    expect(auditsOfT).toEqual([
      {
        actor_id: u.ids.o1,
        actor_role: 'operator',
        action: 'reversal',
        account_ids: [a1.id, b1.id].sort(),
        transaction_id: reversalOfT,
        reversed_transaction_id: t,
        reason: FRAUD,
        request_id: 'req-rev',
        created_at: expect.any(Date) as unknown,
      },
    ]);
    const auditsOfD = await reversalAuditsOf(d);
    expect(auditsOfD.map((audit) => audit.transaction_id)).toEqual([reversalOfD]);

    for (const response of [k1, k2, k3, k4, read]) {
      expect(response.body).not.toContain('Fraud ticket');
    }
    expect(k1Logs.length).toBeGreaterThan(0);
    for (const line of k1Logs) expect(JSON.stringify(line)).not.toContain('Fraud ticket');
    expect(built.logs.text()).not.toContain('Fraud ticket');
  });
});
