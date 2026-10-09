import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Environment } from '../../../src/platform/config/config.js';
import { applicationInfo } from '../../../src/platform/error-reporting/reporter.js';
import { TEST_CURSOR_SECRET } from '../../support/app.js';
import { closePools, ownerPool } from '../../support/db.js';
import { requireEnv } from '../../support/env.js';
import { FakeSentry } from '../../support/fake-sentry.js';
import { bearer, createAccount, deposit, problemOf, withdraw } from '../../support/http.js';
import { openLockSession, type LockSession } from '../../support/sessions.js';
import {
  buildTestApp,
  THROWING_ROUTE_MESSAGE,
  THROWING_ROUTE_PATH,
  type BuiltTestApp,
} from '../../support/test-app.js';
import { K, tokenFor } from '../../support/tokens.js';

const DB_PASSWORD = 'db-pw-7781';
const REDIS_PASSWORD = 'redis-pw-5512';

/** `url` with its user and password replaced. */
function withCredentials(url: string, user: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = user;
  parsed.password = password;
  return parsed.toString();
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** A request to the throwing route of SYS-R37 as the holder of `token`. */
async function throwing(built: BuiltTestApp, token: string, requestId: string) {
  return await built.app.inject({
    method: 'GET',
    url: THROWING_ROUTE_PATH,
    headers: { ...bearer(token), 'x-request-id': requestId },
  });
}

/**
 * The envelope's text without the members the reporter generates (the event id, the times), so a
 * value searched for cannot match them by chance.
 */
function withoutGenerated(body: string): string {
  return body
    .replace(/"event_id":"[0-9a-f]+"/g, '')
    .replace(/"sent_at":"[^"]+"/g, '')
    .replace(/"timestamp":[0-9.]+/g, '');
}

describe('error reporting', () => {
  let fake: FakeSentry;
  const apps: BuiltTestApp[] = [];

  function appWith(env: Environment): BuiltTestApp {
    const built = buildTestApp({ env });
    apps.push(built);
    return built;
  }

  beforeAll(async () => {
    fake = await FakeSentry.start();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const built of apps.splice(0)) await built.app.close();
    fake.envelopes.length = 0;
  });

  afterAll(async () => {
    await fake.close();
    await closePools();
  });

  it('SEC-AC41 reports each 500 once, with its correlation id and route, and no other answer', async () => {
    const built = appWith({
      SENTRY_DSN: fake.dsn(),
      ACCOUNT_LOCK_TIMEOUT_MS: '200',
      RATE_LIMIT_USER_MAX: '8',
    });
    const c1 = tokenFor(randomUUID(), 'customer');
    const c2 = tokenFor(randomUUID(), 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, c1, 'EUR');
    const b1 = await createAccount(built.app, c2, 'EUR');
    expect((await deposit(built.app, o1, a1.id, '1000')).statusCode).toBe(201);
    let session: LockSession | undefined;

    try {
      for (const requestId of ['err-1', 'err-2']) {
        const response = await throwing(built, c1, requestId);
        expect(response.statusCode).toBe(500);
        expect(problemOf(response).type).toBe('/problems/internal-error');
        expect(response.headers['x-request-id']).toBe(requestId);
      }
      const read = (token: string | undefined, id: string) =>
        built.app.inject({
          method: 'GET',
          url: `/v1/accounts/${id}`,
          headers: token === undefined ? {} : bearer(token),
        });
      expect((await read(undefined, a1.id)).statusCode).toBe(401);
      expect((await deposit(built.app, c1, a1.id, '100')).statusCode).toBe(403);
      expect((await read(c1, randomUUID())).statusCode).toBe(404);
      expect((await withdraw(built.app, c1, a1.id, '5000')).statusCode).toBe(422);
      session = await openLockSession();
      await session.lockRow('accounts', a1.id);
      expect((await withdraw(built.app, c1, a1.id, '100')).statusCode).toBe(503);
      await session.release();
      // C2's first request created B1, so the eighth read is its ninth request.
      const statuses: number[] = [];
      for (let index = 0; index < 8; index += 1) {
        statuses.push((await read(c2, b1.id)).statusCode);
      }
      expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 429]);
      await sleep(2000);
    } finally {
      await session?.close();
    }

    expect(fake.envelopes).toHaveLength(2);
    const events = fake.envelopes.map((envelope) => envelope.event);
    expect(events.map((event) => event.tags?.['requestId'])).toEqual(['err-1', 'err-2']);
    for (const event of events) {
      expect(event.tags).toMatchObject({ route: '/v1/test/throw', method: 'GET' });
      expect(event['exception']).toMatchObject({
        values: [{ type: 'Error', value: THROWING_ROUTE_MESSAGE }],
      });
    }
  });

  it('SEC-AC42 a report holds no request data, amount, id, token or secret', async () => {
    const role = `scf_reporting_${randomBytes(4).toString('hex')}`;
    await ownerPool().query(
      `CREATE ROLE ${role} WITH LOGIN PASSWORD '${DB_PASSWORD}' IN ROLE scf_app`,
    );
    try {
      const dsn = fake.dsn('pk-5521');
      const built = appWith({
        LOG_LEVEL: 'trace',
        JWT_SECRET: K,
        CURSOR_SECRET: TEST_CURSOR_SECRET,
        DATABASE_URL: withCredentials(requireEnv('TEST_DATABASE_URL'), role, DB_PASSWORD),
        REDIS_URL: withCredentials(requireEnv('REDIS_URL'), '', REDIS_PASSWORD),
        SENTRY_DSN: dsn,
      });
      const c1Id = randomUUID();
      const v = tokenFor(c1Id, 'customer');
      const o1 = tokenFor(randomUUID(), 'operator');
      const a1 = await createAccount(built.app, v, 'EUR');
      expect((await deposit(built.app, o1, a1.id, '10000')).statusCode).toBe(201);
      built.faults.failAt(
        'after-entries',
        new Error(`withdrawal of 4321 from ${a1.id} by ${c1Id} with k-report-9917`),
      );

      const response = await built.app.inject({
        method: 'POST',
        url: `/v1/accounts/${a1.id}/withdrawals`,
        headers: {
          ...bearer(v),
          'idempotency-key': 'k-report-9917',
          cookie: 'session=c-5521',
          'x-request-id': 'err-5',
        },
        payload: { amount: '4321', currency: 'EUR' },
      });
      built.faults.clear();

      expect(response.statusCode).toBe(500);
      expect(problemOf(response).type).toBe('/problems/internal-error');
      const account = await built.app.inject({
        method: 'GET',
        url: `/v1/accounts/${a1.id}`,
        headers: bearer(v),
      });
      expect(account.json<{ balance: string }>().balance).toBe('10000');
      await fake.waitForEnvelopes(1);
      await sleep(500);
      expect(fake.envelopes).toHaveLength(1);
      const [envelope] = fake.envelopes;
      const event = envelope?.event ?? {};
      expect(Object.keys(event).sort()).toEqual(
        [
          'environment',
          'event_id',
          'exception',
          'level',
          'platform',
          'release',
          'tags',
          'timestamp',
        ].sort(),
      );
      expect(event.tags).toEqual({
        requestId: 'err-5',
        route: '/v1/accounts/:id/withdrawals',
        method: 'POST',
        replicaId: expect.any(String) as unknown,
      });
      expect(event['release']).toBe(applicationInfo().release);
      expect(event['exception']).toMatchObject({
        values: [{ value: 'withdrawal of <n> from <uuid> by <uuid> with [Redacted]' }],
      });
      const body = withoutGenerated(envelope?.body ?? '');
      for (const forbidden of [
        v,
        'k-report-9917',
        'c-5521',
        a1.id,
        c1Id,
        K,
        TEST_CURSOR_SECRET,
        DB_PASSWORD,
        REDIS_PASSWORD,
        'pk-5521',
      ]) {
        expect(body).not.toContain(forbidden);
      }
      expect(body).not.toMatch(/(^|[^0-9])4321([^0-9]|$)/);
      expect(built.logs.text()).not.toContain('pk-5521');
    } finally {
      await ownerPool().query(`DROP ROLE IF EXISTS ${role}`);
    }
  });

  it('SEC-AC44 error reporting is off by default, and then nothing is sent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const answers = [];
    for (const env of [{}, { SENTRY_DSN: '' }]) {
      const built = appWith(env);
      expect(built.app.errorReporter).toBeUndefined();
      const c1 = tokenFor(randomUUID(), 'customer');
      answers.push(await throwing(built, c1, 'err-4'));
      expect(
        built.logs.lines().filter((line) => line.msg === 'error reporting is off'),
      ).toHaveLength(1);
    }
    await sleep(2000);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fake.envelopes).toHaveLength(0);

    const on = appWith({ SENTRY_DSN: fake.dsn() });
    expect(on.app.errorReporter).toBeDefined();
    answers.push(await throwing(on, tokenFor(randomUUID(), 'customer'), 'err-4'));
    expect(on.logs.lines().filter((line) => line.msg === 'error reporting is off')).toHaveLength(0);
    await fake.waitForEnvelopes(1);
    expect(fake.envelopes.map((envelope) => envelope.event.tags?.['requestId'])).toEqual(['err-4']);

    const [first, ...others] = answers;
    const headersOf = (answer: typeof first) =>
      Object.fromEntries(Object.entries(answer?.headers ?? {}).filter(([name]) => name !== 'date'));
    for (const answer of others) {
      expect(answer.statusCode).toBe(500);
      expect(headersOf(answer)).toEqual(headersOf(first));
      expect(answer.rawPayload.equals(first?.rawPayload ?? Buffer.alloc(0))).toBe(true);
    }
    expect(first?.statusCode).toBe(500);
  });
});
