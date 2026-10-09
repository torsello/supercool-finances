import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listen } from '../../../src/app.js';
import { SPEC_007_DEFAULTS, testConfig } from '../../support/app.js';
import { closePools } from '../../support/db.js';
import { createAccount, deposit, problemOf, transfer, withdraw } from '../../support/http.js';
import { scrape, valueOf, type Sample } from '../../support/metrics.js';
import { freePort } from '../../support/ports.js';
import { openLockSession, type LockSession } from '../../support/sessions.js';
import { buildTestApp, type BuiltTestApp } from '../../support/test-app.js';
import { tokenFor } from '../../support/tokens.js';

/** A database error with a SQLSTATE, as `pg` raises it. */
function databaseError(code: string): pg.DatabaseError {
  const error = new pg.DatabaseError(`fake ${code}`, 0, 'error');
  error.code = code;
  return error;
}

describe('metrics', () => {
  let built: BuiltTestApp;
  let session: LockSession;
  let port: number;
  let metricsPort: number;

  beforeAll(async () => {
    port = await freePort();
    metricsPort = await freePort();
    const env = {
      ...SPEC_007_DEFAULTS,
      ACCOUNT_LOCK_TIMEOUT_MS: '200',
      PORT: String(port),
      METRICS_PORT: String(metricsPort),
    };
    built = buildTestApp({ env });
    await listen(built.app, testConfig(env), '127.0.0.1');
    session = await openLockSession();
  });

  afterAll(async () => {
    await session.close();
    await built.app.close();
    await closePools();
  });

  it('SEC-AC32 /metrics on METRICS_PORT counts requests, movements, replays, lock timeouts and retries, labelled with route templates only', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const c2 = tokenFor(randomUUID(), 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, c1, 'EUR');
    const b1 = await createAccount(built.app, c2, 'EUR');
    expect((await deposit(built.app, o1, a1.id, '1000')).statusCode).toBe(201);
    const u = randomUUID();
    const before = await scrape(metricsPort);

    const k1 = randomUUID();
    expect((await deposit(built.app, o1, a1.id, '100', { key: k1 })).statusCode).toBe(201);
    const replay = await deposit(built.app, o1, a1.id, '100', { key: k1 });
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(problemOf(await withdraw(built.app, c1, a1.id, '5000')).type).toBe(
      '/problems/insufficient-funds',
    );
    expect((await withdraw(built.app, c1, u, '100')).statusCode).toBe(404);
    built.faults.failAt('after-entries', databaseError('40001'));
    try {
      expect((await transfer(built.app, c1, a1.id, b1.id, '100')).statusCode).toBe(503);
    } finally {
      built.faults.clear();
    }
    await session.lockRow('accounts', a1.id);
    try {
      expect((await withdraw(built.app, c1, a1.id, '100')).statusCode).toBe(503);
    } finally {
      await session.release();
    }
    const unmatched = await fetch(`http://127.0.0.1:${String(port)}/no-such-path`);
    expect(unmatched.status).toBe(404);

    const after = await scrape(metricsPort);
    const rise = (name: string, labels: Record<string, string> = {}) =>
      valueOf(after, name, labels) - valueOf(before, name, labels);

    const movements = 'scf_money_movements_total';
    expect(rise(movements, { kind: 'deposit', outcome: 'applied' })).toBe(1);
    expect(rise(movements, { kind: 'withdrawal', outcome: 'rejected' })).toBe(2);
    expect(rise(movements, { kind: 'transfer', outcome: 'failed' })).toBe(1);
    expect(rise(movements, { kind: 'withdrawal', outcome: 'failed' })).toBe(1);
    expect(rise(movements)).toBe(5);
    expect(rise('scf_idempotent_replays_total', { kind: 'deposit' })).toBe(1);
    expect(rise('scf_idempotent_replays_total')).toBe(1);
    expect(rise('scf_lock_timeouts_total', { lock: 'account' })).toBe(1);
    expect(rise('scf_lock_timeouts_total')).toBe(1);
    expect(rise('scf_transaction_retries_total', { sqlstate: '40001' })).toBe(2);
    expect(rise('scf_transaction_retries_total')).toBe(2);
    expect(rise('scf_transaction_retries_exhausted_total')).toBe(1);

    const durations = after.filter(
      (sample: Sample) => sample.name === 'scf_http_request_duration_seconds_count',
    );
    expect(durations).toContainEqual(
      expect.objectContaining({
        labels: { method: 'POST', route: '/v1/accounts/:id/deposits', status_code: '201' },
      }),
    );
    expect(durations).toContainEqual(
      expect.objectContaining({
        labels: { method: 'GET', route: 'unmatched', status_code: '404' },
      }),
    );
    for (const sample of after) {
      for (const value of Object.values(sample.labels)) {
        for (const id of [a1.id, b1.id, u]) expect(value, sample.name).not.toContain(id);
      }
    }
    const poolStates = after
      .filter((sample) => sample.name === 'scf_db_pool_connections')
      .map((sample) => sample.labels['state'])
      .sort();
    expect(poolStates).toEqual(['idle', 'total', 'waiting']);

    const onPort = await fetch(`http://127.0.0.1:${String(port)}/metrics`);
    expect(onPort.status).toBe(404);
  });
});
