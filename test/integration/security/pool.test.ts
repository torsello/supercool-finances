import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp, SPEC_007_DEFAULTS } from '../../support/app.js';
import { blockedBackends } from '../../support/backends.js';
import {
  balanceOf,
  closePools,
  createCustomerAccount,
  writeDirectDeposit,
} from '../../support/db.js';
import { bearer, problemOf, withdraw } from '../../support/http.js';
import { parseMetrics, valueOf } from '../../support/metrics.js';
import { openLockSession } from '../../support/sessions.js';
import { tokenFor } from '../../support/tokens.js';
import { keyRecord } from '../movements/support.js';

const ACQUIRE_TIMEOUTS = 'scf_db_pool_acquire_timeouts_total';

describe('the connection pool', () => {
  const apps: BuiltApp[] = [];

  afterAll(async () => {
    await Promise.all(
      apps.map(async ({ app }) => {
        await app.close();
      }),
    );
    await closePools();
  });

  async function started(env: Record<string, string>): Promise<BuiltApp> {
    const built = buildProductionApp({ env: { ...SPEC_007_DEFAULTS, ...env } });
    apps.push(built);
    await built.app.ready();
    return built;
  }

  async function acquireTimeouts(built: BuiltApp): Promise<number> {
    const { body } = await built.app.metrics.exposition();
    return valueOf(parseMetrics(body), ACQUIRE_TIMEOUTS);
  }

  /** A customer with an account of `balance` EUR, written directly to the database. */
  async function customerWith(balance: string) {
    const id = randomUUID();
    const account = await createCustomerAccount({ currency: 'EUR', ownerId: id });
    if (balance !== '0') await writeDirectDeposit(account, balance);
    return { token: tokenFor(id, 'customer'), id, account };
  }

  /** A request with the time it took to answer. */
  async function timed(request: Promise<LightMyRequestResponse>) {
    const started = performance.now();
    const response = await request;
    return { response, ms: performance.now() - started };
  }

  it('SEC-AC27 with every pool connection held, a request answers 503 after the acquire timeout, writes nothing and is counted', async () => {
    const built = await started({
      DB_POOL_MAX: '2',
      DB_POOL_ACQUIRE_TIMEOUT_MS: '200',
      ACCOUNT_LOCK_TIMEOUT_MS: '4000',
      IDEMPOTENCY_WAIT_TIMEOUT_MS: '300',
      REQUEST_TIMEOUT_MS: '60000',
      SHUTDOWN_TIMEOUT_MS: '60000',
    });
    const c1 = await customerWith('1000');
    const c2 = await customerWith('1000');
    const k2 = randomUUID();
    const before = await acquireTimeouts(built);
    const session = await openLockSession();
    try {
      await session.lockRow('accounts', c1.account.id);
      const settled: boolean[] = [];
      const holders = [0, 1].map(async (index) => {
        const response = await withdraw(built.app, c1.token, c1.account.id, '100');
        settled[index] = true;
        return response;
      });
      // The first waits for the session's lock, the second queues behind the first on A1's row.
      await blockedBackends({ count: 2 });

      const read = await timed(
        built.app.inject({
          method: 'GET',
          url: `/v1/accounts/${c2.account.id}`,
          headers: bearer(c2.token),
        }),
      );
      const withdrawal = await timed(
        withdraw(built.app, c2.token, c2.account.id, '100', { key: k2 }),
      );
      for (const { response, ms } of [read, withdrawal]) {
        expect(response.statusCode).toBe(503);
        expect(problemOf(response).type).toBe('/problems/service-unavailable');
        expect(response.headers['retry-after']).toBe('1');
        expect(ms).toBeGreaterThanOrEqual(200);
      }
      expect(settled).toEqual([]);
      expect(await keyRecord(c2.id, k2)).toBeUndefined();
      expect(await acquireTimeouts(built)).toBe(before + 2);

      await session.release();
      for (const holder of await Promise.all(holders)) expect(holder.statusCode).toBe(201);
    } finally {
      await session.close();
    }

    const reread = await built.app.inject({
      method: 'GET',
      url: `/v1/accounts/${c2.account.id}`,
      headers: bearer(c2.token),
    });
    expect(reread.statusCode).toBe(200);
    const repeated = await withdraw(built.app, c2.token, c2.account.id, '100', { key: k2 });
    expect(repeated.statusCode).toBe(201);
    expect(repeated.headers).not.toHaveProperty('idempotent-replayed');
    expect(await balanceOf(c1.account.id)).toBe('800');
    expect(await balanceOf(c2.account.id)).toBe('900');
  });

  it('SEC-AC28 a burst of 200 requests queues for the default pool in arrival order and gets no 5xx', async () => {
    const built = await started({ RATE_LIMIT_USER_MAX: '1000000' });
    const c1 = await customerWith('10000');
    const c2 = await customerWith('0');
    const before = await acquireTimeouts(built);

    const [withdrawals, reads] = await Promise.all([
      Promise.all(
        Array.from({ length: 100 }, () => withdraw(built.app, c1.token, c1.account.id, '300')),
      ),
      Promise.all(
        Array.from({ length: 100 }, () =>
          built.app.inject({
            method: 'GET',
            url: `/v1/accounts/${c2.account.id}`,
            headers: bearer(c2.token),
          }),
        ),
      ),
    ]);

    const all = [...withdrawals, ...reads];
    expect(all.filter((response) => response.statusCode >= 500)).toEqual([]);
    expect(withdrawals.filter((response) => response.statusCode === 201)).toHaveLength(33);
    const refused = withdrawals.filter((response) => response.statusCode === 422);
    expect(refused).toHaveLength(67);
    for (const response of refused) {
      expect(problemOf(response).type).toBe('/problems/insufficient-funds');
    }
    expect(reads.every((response) => response.statusCode === 200)).toBe(true);
    expect(await acquireTimeouts(built)).toBe(before);
    expect(await balanceOf(c1.account.id)).toBe('100');
  });

  it('SEC-R41 a movement answered 503 before it reached the idempotency step is not counted as a failed movement', async () => {
    const built = await started({
      DB_POOL_MAX: '1',
      DB_POOL_ACQUIRE_TIMEOUT_MS: '200',
      ACCOUNT_LOCK_TIMEOUT_MS: '4000',
      IDEMPOTENCY_WAIT_TIMEOUT_MS: '300',
      REQUEST_TIMEOUT_MS: '60000',
      SHUTDOWN_TIMEOUT_MS: '60000',
    });
    const c1 = await customerWith('1000');
    const c2 = await customerWith('1000');
    const failed = async () => {
      const { body } = await built.app.metrics.exposition();
      return valueOf(parseMetrics(body), 'scf_money_movements_total', {
        kind: 'withdrawal',
        outcome: 'failed',
      });
    };
    const before = await failed();
    const session = await openLockSession();
    try {
      await session.lockRow('accounts', c1.account.id);
      const holder = withdraw(built.app, c1.token, c1.account.id, '100');
      await blockedBackends({ count: 1, by: session.pid });

      const refused = await withdraw(built.app, c2.token, c2.account.id, '100');
      expect(refused.statusCode).toBe(503);
      expect(await failed()).toBe(before);

      await session.release();
      expect((await holder).statusCode).toBe(201);
    } finally {
      await session.close();
    }
    expect(await failed()).toBe(before);
  });
});
