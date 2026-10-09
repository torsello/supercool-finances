import { beforeAll, describe, expect, it } from 'vitest';
import { createAccount, getAccount } from './support/api.js';
import { headerOf, send } from './support/http.js';
import { containerLogs, daemonTime, ensureStack, jsonLines } from './support/stack.js';
import { freshUser, tokenFor } from './support/tokens.js';
import { REPLICAS } from './support/urls.js';
import { waitFor } from './support/wait.js';

/** Every line of nginx's access log and of both replicas since `since`, once `ready` holds. */
async function logsOnce(
  since: string,
  ready: (nginx: Record<string, unknown>[], replicas: Record<string, unknown>[]) => boolean,
): Promise<{ nginx: Record<string, unknown>[]; replicas: Record<string, unknown>[] }> {
  return await waitFor('the log lines of the four reads', async () => {
    const nginx = jsonLines(await containerLogs('nginx', since));
    const replicas = (
      await Promise.all(REPLICAS.map(async (replica) => await containerLogs(replica, since)))
    ).flatMap((lines) => jsonLines(lines));
    return ready(nginx, replicas) ? { nginx, replicas } : undefined;
  });
}

describe('the correlation id', () => {
  beforeAll(ensureStack);

  it('SEC-AC15 one correlation id goes from the load balancer to the logs, and no query string reaches its access log', async () => {
    const c1 = await freshUser('customer');
    const a1 = (await createAccount(c1.token)).id;
    const since = await daemonTime();

    const generated = await getAccount(c1.token, a1);
    const given = await getAccount(c1.token, a1, { headers: { 'x-request-id': 'e2e-corr-1' } });
    const invalid = await getAccount(c1.token, a1, { headers: { 'x-request-id': 'bad id!' } });
    const v2 = await tokenFor(c1.id, 'customer');
    const queried = await send({ url: `/v1/accounts/${a1}?access_token=${v2}` });

    const id1 = headerOf(generated, 'x-request-id') ?? '';
    expect(generated.status).toBe(200);
    expect(id1).toMatch(/^[0-9a-f]{32}$/);
    expect(headerOf(given, 'x-request-id')).toBe('e2e-corr-1');
    const id3 = headerOf(invalid, 'x-request-id') ?? '';
    expect(id3).not.toBe('');
    expect(id3).not.toBe('bad id!');
    const id4 = headerOf(queried, 'x-request-id') ?? '';

    const { nginx, replicas } = await logsOnce(
      since,
      (nginxLines, replicaLines) =>
        [id1, 'e2e-corr-1'].every(
          (id) =>
            nginxLines.some((line) => line['requestId'] === id) &&
            replicaLines.some(
              (line) => line['reqId'] === id && line['msg'] === 'request completed',
            ),
        ) && [id3, id4].every((id) => nginxLines.some((line) => line['responseRequestId'] === id)),
    );

    // The generated id and the client's: in nginx's line and in every line the replica wrote for
    // the request, its incoming and its completed line.
    for (const id of [id1, 'e2e-corr-1']) {
      expect(nginx.filter((line) => line['requestId'] === id)).toHaveLength(1);
      const lines = replicas.filter((line) => line['reqId'] === id);
      expect(lines.map((line) => line['msg'])).toEqual(['incoming request', 'request completed']);
    }

    // An id the service refuses: the response carries the one it generated, which nginx logs.
    const refused = nginx.find((line) => line['responseRequestId'] === id3);
    expect(refused?.['requestId']).toBe('bad id!');

    // A token in the query string never reaches the access log. Checked with booleans whose
    // messages name no token, so a failure never prints one.
    const line = nginx.find((item) => item['responseRequestId'] === id4);
    expect(line !== undefined, 'access log line of the request with a query string').toBe(true);
    expect(line?.['path'] === `/v1/accounts/${a1}`, 'access log path without query string').toBe(
      true,
    );
    const text = JSON.stringify(line);
    expect(text.includes('?'), 'query string in access log').toBe(false);
    expect(text.includes('access_token'), 'query parameter name in access log').toBe(false);
    for (const [index, segment] of v2.split('.').entries()) {
      expect(text.includes(segment), `token segment ${String(index + 1)} in access log`).toBe(
        false,
      );
    }
  });
});
