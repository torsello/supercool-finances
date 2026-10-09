import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp, SPEC_007_DEFAULTS } from '../../support/app.js';
import { closePools } from '../../support/db.js';
import { bearer, createAccount } from '../../support/http.js';
import type { LogLine } from '../../support/logs.js';
import { tokenFor } from '../../support/tokens.js';

describe('trusted proxies', () => {
  const apps: BuiltApp[] = [];

  afterAll(async () => {
    await Promise.all(
      apps.map(async ({ app }) => {
        await app.close();
      }),
    );
    await closePools();
  });

  async function started(env: Record<string, string | undefined>): Promise<BuiltApp> {
    const built = buildProductionApp({ env: { ...SPEC_007_DEFAULTS, ...env } });
    apps.push(built);
    await built.app.ready();
    return built;
  }

  /** The client address the request log line of `reqId` records. */
  function loggedClient(built: BuiltApp, reqId: string): unknown {
    const line = built.logs
      .linesOf(reqId)
      .find((candidate: LogLine) => candidate.msg === 'incoming request');
    const req = line?.['req'] as { remoteAddress?: unknown } | undefined;
    return req?.remoteAddress;
  }

  it('SEC-AC14 X-Forwarded-For gives the client address only from a peer in TRUSTED_PROXY_CIDRS, as its rightmost untrusted address', async () => {
    const untrusting = await started({ TRUSTED_PROXY_CIDRS: undefined });
    const trusting = await started({ TRUSTED_PROXY_CIDRS: '10.0.0.0/8' });
    const c1 = tokenFor(randomUUID(), 'customer');
    const a1 = await createAccount(untrusting.app, c1, 'EUR');

    const reads: [BuiltApp, string, string][] = [
      [untrusting, '10.0.0.5', '1.2.3.4'],
      [trusting, '10.0.0.5', '1.2.3.4'],
      [trusting, '10.0.0.5', '6.6.6.6, 1.2.3.4'],
      [trusting, '10.0.0.5', '1.2.3.4, 10.0.0.9'],
      [trusting, '192.168.1.9', '1.2.3.4'],
    ];
    const logged: unknown[] = [];
    for (const [index, [built, peer, forwarded]] of reads.entries()) {
      const reqId = `xff-${String(index)}-${randomUUID()}`;
      const response = await built.app.inject({
        method: 'GET',
        url: `/v1/accounts/${a1.id}`,
        remoteAddress: peer,
        headers: { ...bearer(c1), 'x-forwarded-for': forwarded, 'x-request-id': reqId },
      });
      expect(response.statusCode).toBe(200);
      logged.push(loggedClient(built, reqId));
    }

    expect(logged).toEqual(['10.0.0.5', '1.2.3.4', '1.2.3.4', '1.2.3.4', '192.168.1.9']);
  });
});
