import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { closePools } from '../../support/db.js';
import { dsnFor, FakeSentry } from '../../support/fake-sentry.js';
import { bearer, problemOf } from '../../support/http.js';
import { LOG_LEVEL } from '../../support/logs.js';
import { freePort } from '../../support/ports.js';
import { buildTestApp, THROWING_ROUTE_PATH } from '../../support/test-app.js';
import { tokenFor } from '../../support/tokens.js';

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('error reporting with an unreachable or slow endpoint', () => {
  afterAll(async () => {
    await closePools();
  });

  it('SEC-AC45 an unreachable or slow endpoint changes no answer, and only the transitions are logged', async () => {
    const port = await freePort();
    const dsn = dsnFor(port, 'pk-unavailable-3391');
    const built = buildTestApp({ env: { SENTRY_DSN: dsn } });
    const c1 = tokenFor(randomUUID(), 'customer');
    let fake: FakeSentry | undefined;
    const throwing = async () => {
      const response = await built.app.inject({
        method: 'GET',
        url: THROWING_ROUTE_PATH,
        headers: bearer(c1),
      });
      expect(response.statusCode).toBe(500);
      expect(problemOf(response).type).toBe('/problems/internal-error');
      return response;
    };
    const reporting = () =>
      built.logs
        .lines()
        .filter((line) => typeof line.msg === 'string' && line.msg.startsWith('error reporting'));

    try {
      for (let index = 0; index < 3; index += 1) await throwing();
      await sleep(300);
      expect(reporting().map((line) => [line.level, line.msg])).toEqual([
        [LOG_LEVEL.warn, 'error reporting is failing'],
      ]);

      fake = await FakeSentry.start(port);
      fake.holdMs = 5000;
      await throwing();
      // Answered before the endpoint answered its envelope.
      expect(fake.envelopes.every((envelope) => envelope.answered === undefined)).toBe(true);
      await fake.waitForEnvelopes(1);
      // The held send is abandoned at 2000 ms, while reporting is already failing.
      await sleep(2300);
      expect(built.app.errorReporter?.pending).toBe(0);

      fake.holdMs = 0;
      await throwing();
      await fake.waitForEnvelopes(2);
      await sleep(300);
      await throwing();
      await fake.waitForEnvelopes(3);
      await sleep(300);

      expect(fake.accepted()).toHaveLength(2);
      expect(reporting().map((line) => [line.level, line.msg])).toEqual([
        [LOG_LEVEL.warn, 'error reporting is failing'],
        [LOG_LEVEL.info, 'error reporting works again'],
      ]);
      const text = built.logs.text();
      expect(text).not.toContain(dsn);
      expect(text).not.toContain('pk-unavailable-3391');
    } finally {
      await built.app.close();
      await fake?.close();
    }
  });
});
