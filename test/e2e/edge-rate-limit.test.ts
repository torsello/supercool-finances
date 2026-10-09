import { beforeAll, describe, expect, it } from 'vitest';
import { readCompose, withDefaults } from '../support/deployment.js';
import { recordResponses } from './support/recorder.js';
import {
  composeOk,
  containerLogs,
  containerOf,
  daemonTime,
  ensureStack,
  jsonLines,
  runToolsOk,
} from './support/stack.js';
import { REPLICAS } from './support/urls.js';
import { waitFor } from './support/wait.js';

/** One answer the flood client of the tools service received. */
interface Answer {
  status: number;
  retryAfter: string | undefined;
  contentType: string | undefined;
  requestId: string | undefined;
  body: string;
}

describe('the per-IP limit of the load balancer', () => {
  beforeAll(async () => {
    await ensureStack();
    // The flood client runs in the tools image: built from the working tree, like the stack.
    await composeOk(['build', '--quiet', 'tools']);
  });

  it('SEC-AC01 answers the excess of one client IP with 429 at the load balancer, whatever X-Forwarded-For says', async () => {
    // Given: RATE_LIMIT_IP_RPS and RATE_LIMIT_IP_BURST unset, so nginx has the defaults.
    const nginx = await containerOf('nginx');
    const rawEnvironment = readCompose().service('nginx').rawEnvironment;
    for (const name of ['RATE_LIMIT_IP_RPS', 'RATE_LIMIT_IP_BURST']) {
      expect(nginx.Config.Env ?? []).toContain(
        `${name}=${withDefaults(rawEnvironment[name] ?? '')}`,
      );
    }
    const since = await daemonTime();

    // One client, in the tools service on the stack's network, sends 3000 requests through nginx
    // at the same time, each on its own connection and with its own X-Forwarded-For, which nginx
    // must not key on; then waits the AC's 3 seconds and sends one more.
    const flood = await runToolsOk([
      'npx',
      'tsx',
      'test/e2e/support/flood-client.ts',
      'http://nginx:8080/health/live',
      '3000',
      '3000',
    ]);
    const line = flood.stdout.split('\n').find((item) => item.startsWith('{')) ?? '{}';
    const { answers, last } = JSON.parse(line) as { answers: Answer[]; last: Answer };
    for (const answer of [...answers, last]) recordResponses(answer.status);

    expect(answers).toHaveLength(3000);
    const count = (status: number): number =>
      answers.filter((answer) => answer.status === status).length;
    const statuses = [...new Set(answers.map((answer) => answer.status))].sort();
    console.info(
      `SEC-AC01: ${statuses.map((status) => `${String(count(status))} × ${String(status)}`).join(', ')}`,
    );
    expect(count(200)).toBeGreaterThanOrEqual(1000);
    expect(count(429)).toBeGreaterThanOrEqual(1);
    expect(count(503)).toBe(0);

    const limited = answers.filter((answer) => answer.status === 429);
    for (const answer of limited) {
      expect(answer.retryAfter).toBe('1');
      expect(answer.contentType).toBe('application/problem+json');
      const problem = JSON.parse(answer.body) as Record<string, unknown>;
      expect(problem).toMatchObject({ type: '/problems/rate-limited', status: 429 });
      expect(problem['requestId']).toBe(answer.requestId);
    }

    // Answered at the load balancer: the replicas logged no line of a refused request. Every
    // line a replica writes for a request carries its correlation id as reqId (SEC-R21). The
    // logs are read once they hold every request that got a 200, so none is still on its way.
    const passed = answers
      .filter((answer) => answer.status === 200)
      .map((answer) => answer.requestId ?? '');
    const logged = await waitFor('the replicas’ lines of every request answered 200', async () => {
      const lines = jsonLines(
        (
          await Promise.all(REPLICAS.map(async (replica) => await containerLogs(replica, since)))
        ).flat(),
      );
      const ids = new Set(lines.map((item) => item['reqId']));
      return passed.every((id) => ids.has(id)) ? ids : undefined;
    });
    const refused = limited.map((answer) => answer.requestId ?? '');
    expect(refused.filter((id) => logged.has(id))).toEqual([]);

    expect(last.status).toBe(200);
  });
});
