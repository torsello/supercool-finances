import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { balanceOf, closePools, runtimePool } from '../../support/db.js';
import { createAccount, deposit, problemOf } from '../../support/http.js';
import { LOG_LEVEL } from '../../support/logs.js';
import { openLockSession, type LockSession } from '../../support/sessions.js';
import { tokenFor } from '../../support/tokens.js';

describe('a request whose database connection is lost (SYS-R22, SEC-R21)', () => {
  let built: BuiltApp;
  let session: LockSession;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
    session = await openLockSession();
  });

  afterAll(async () => {
    await session.close();
    await built.app.close();
    await closePools();
  });

  /** The backend of the runtime role that waits for a row lock, once there is exactly one. */
  async function waitingBackend(): Promise<number> {
    const deadline = Date.now() + 5000;
    for (;;) {
      const result = await runtimePool().query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity
          WHERE usename = current_user AND pid <> pg_backend_pid()
            AND cardinality(pg_blocking_pids(pid)) > 0`,
      );
      const [row, ...others] = result.rows;
      if (row !== undefined && others.length === 0) return row.pid;
      if (Date.now() >= deadline) throw new Error('no single backend waits for a lock');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it('SYS-R22 SEC-R21 the request writes its own line with its reqId and the SQLSTATE; only the pool lines carry no reqId', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const a1 = await createAccount(built.app, c1);
    expect(
      (await deposit(built.app, tokenFor(randomUUID(), 'operator'), a1.id, '1000')).statusCode,
    ).toBe(201);

    await session.lockRow('accounts', a1.id);
    built.logs.clear();
    const pending = built.app.inject({
      method: 'POST',
      url: `/v1/accounts/${a1.id}/withdrawals`,
      headers: {
        authorization: `Bearer ${c1}`,
        'idempotency-key': randomUUID(),
        'x-request-id': 'req-lost',
      },
      payload: { amount: '100', currency: 'EUR' },
    });
    const pid = await waitingBackend();
    await session.waitUntilBlocked(pid);
    await runtimePool().query('SELECT pg_terminate_backend($1)', [pid]);
    const response = await pending;
    await session.release();

    expect(response.statusCode).toBe(503);
    const own = built.logs
      .linesOf('req-lost')
      .filter((line) => (line.level ?? 0) >= LOG_LEVEL.warn);
    expect(own.map((line) => line['sqlstate'])).toContain('57P01');

    // The pool's own line about the connection belongs to no request.
    const lost = built.logs.lines().filter((line) => line.msg === 'database connection lost');
    for (const line of lost) expect(line.reqId).toBeUndefined();

    expect(await balanceOf(a1.id)).toBe('1000');
  });
  it('SEC-AC48 a withdrawal whose connection is lost answers 503 with Retry-After: 1, moves no money, and the retry with the same key runs it once', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const a1 = await createAccount(built.app, c1);
    expect(
      (await deposit(built.app, tokenFor(randomUUID(), 'operator'), a1.id, '1000')).statusCode,
    ).toBe(201);
    const key = randomUUID();
    const send = () =>
      built.app.inject({
        method: 'POST',
        url: `/v1/accounts/${a1.id}/withdrawals`,
        headers: { authorization: `Bearer ${c1}`, 'idempotency-key': key },
        payload: { amount: '100', currency: 'EUR' },
      });

    await session.lockRow('accounts', a1.id);
    const pending = send();
    const pid = await waitingBackend();
    await session.waitUntilBlocked(pid);
    await runtimePool().query('SELECT pg_terminate_backend($1)', [pid]);
    const lost = await pending;
    await session.release();

    expect(lost.statusCode).toBe(503);
    expect(lost.headers['retry-after']).toBe('1');
    expect(problemOf(lost).type).toBe('/problems/service-unavailable');
    expect(await balanceOf(a1.id)).toBe('1000');

    const retried = await send();
    expect(retried.statusCode).toBe(201);
    expect(retried.headers['idempotent-replayed']).toBeUndefined();
    const replayed = await send();
    expect(replayed.statusCode).toBe(201);
    expect(replayed.headers['idempotent-replayed']).toBe('true');
    expect(replayed.body).toBe(retried.body);
    expect(await balanceOf(a1.id)).toBe('900');
  });
});
