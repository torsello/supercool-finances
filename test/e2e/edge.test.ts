import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { readCompose } from '../support/deployment.js';
import { customerWithAccounts, getAccount } from './support/api.js';
import { bearer, headerOf, problemOf, send, type E2eResponse } from './support/http.js';
import {
  containerLogs,
  daemonTime,
  ensureStack,
  jsonLines,
  serviceStates,
} from './support/stack.js';
import { freshUser } from './support/tokens.js';
import { REPLICAS } from './support/urls.js';
import { waitFor } from './support/wait.js';

/** The replica log lines of one request, found by its correlation id, once Docker has them. */
async function replicaLinesOf(
  requestId: string,
  since: string,
): Promise<Record<string, unknown>[]> {
  return await waitFor(`the replica log lines of ${requestId}`, async () => {
    const lines = (
      await Promise.all(REPLICAS.map(async (replica) => await containerLogs(replica, since)))
    ).flatMap((replicaLines) =>
      jsonLines(replicaLines).filter((line) => line['reqId'] === requestId),
    );
    return lines.some((line) => line['msg'] === 'request completed') ? lines : undefined;
  });
}

/** nginx's access log line of one request, by the id it forwarded. */
async function nginxLineOf(requestId: string, since: string): Promise<Record<string, unknown>> {
  return await waitFor(`the nginx access log line of ${requestId}`, async () =>
    jsonLines(await containerLogs('nginx', since)).find((line) => line['requestId'] === requestId),
  );
}

describe('the load balancer’s edge', () => {
  beforeAll(ensureStack);

  it('SEC-AC10 passes bodies up to 32 KB to the service, replaces X-Forwarded-For, hides /metrics and its version, and publishes no metrics port', async () => {
    const operator = await freshUser('operator');
    const {
      user: c1,
      accounts: [a1],
    } = await customerWithAccounts(operator, ['1000']);
    const accountId = a1?.id ?? '';
    const since = await daemonTime();

    // A 20000-byte JSON body: above the service's 16384 bytes, under nginx's 32 KB.
    const shell = JSON.stringify({ amount: '100', currency: 'EUR', padding: '' });
    const body = JSON.stringify({
      amount: '100',
      currency: 'EUR',
      padding: 'x'.repeat(20_000 - Buffer.byteLength(shell)),
    });
    expect(Buffer.byteLength(body)).toBe(20_000);
    const tooLarge = await send({
      method: 'POST',
      url: `/v1/accounts/${accountId}/withdrawals`,
      headers: {
        ...bearer(c1.token),
        'idempotency-key': randomUUID(),
        'content-type': 'application/json',
        'x-request-id': 'edge-413',
      },
      body,
    });
    expect(tooLarge.status).toBe(413);
    expect(headerOf(tooLarge, 'content-type')).toBe('application/problem+json');
    expect(problemOf(tooLarge).type).toBe('/problems/payload-too-large');
    // From the service, not nginx: a replica logged the request and its 413.
    const served = await replicaLinesOf('edge-413', since);
    expect(
      served.map((line) => (line['res'] as { statusCode?: number } | undefined)?.statusCode),
    ).toContain(413);

    // The client's X-Forwarded-For is replaced by nginx's peer, which the service logs.
    const read = await getAccount(c1.token, accountId, {
      headers: { 'x-forwarded-for': '6.6.6.6', 'x-request-id': 'edge-xff' },
    });
    expect(read.status).toBe(200);
    const peer = (await nginxLineOf('edge-xff', since))['remoteAddr'];
    const incoming = (await replicaLinesOf('edge-xff', since)).find(
      (line) => line['msg'] === 'incoming request',
    );
    const remoteAddress = (incoming?.['req'] as { remoteAddress?: string } | undefined)
      ?.remoteAddress;
    expect(typeof peer).toBe('string');
    expect(remoteAddress).toBe(peer);
    expect(remoteAddress).not.toBe('6.6.6.6');

    const metrics = await send({ url: '/metrics' });
    expect(metrics.status).toBe(404);

    for (const response of [tooLarge, read, metrics] as E2eResponse[]) {
      expect(headerOf(response, 'server')).toBe('nginx');
    }

    // No published port is METRICS_PORT.
    const metricsPort = Number(
      readCompose().service('api-1').environment['METRICS_PORT'] ?? '9464',
    );
    const published = (await serviceStates())
      .flatMap((state) => state.Publishers ?? [])
      .filter((publisher) => publisher.PublishedPort !== 0);
    expect(published.length).toBeGreaterThan(0);
    for (const publisher of published) {
      expect(publisher.PublishedPort).not.toBe(metricsPort);
      expect(publisher.TargetPort).not.toBe(metricsPort);
    }
  });
});
