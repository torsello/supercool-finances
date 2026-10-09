import { beforeAll, describe, expect, it } from 'vitest';
import { DEMO_USERS } from '../../scripts/seed.js';
import { getAccount } from './support/api.js';
import type { E2eResponse } from './support/http.js';
import {
  containerLogs,
  daemonTime,
  ensureStack,
  jsonLines,
  seedStack,
  toolsTokens,
  waitForBothReplicasThroughNginx,
  type SeedOutput,
} from './support/stack.js';
import { REPLICAS } from './support/urls.js';
import { waitFor } from './support/wait.js';

/** Whether a JSON value has a member named `name` at any depth. */
function hasMember(value: unknown, name: string): boolean {
  if (Array.isArray(value)) return value.some((item) => hasMember(item, name));
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([key, item]) => key === name || hasMember(item, name));
}

describe('round robin over the replicas', () => {
  let seeded: SeedOutput;
  let token = '';

  beforeAll(async () => {
    await ensureStack();
    seeded = await seedStack();
    const c1 = DEMO_USERS.find((user) => user.name === 'demo-customer-1')?.id ?? '';
    [token = ''] = await toolsTokens([{ sub: c1, role: 'customer' }]);
    await waitForBothReplicasThroughNginx();
  });

  it('DEP-AC09 requests reach both replicas, visible by replica id in the logs and never in a response', async () => {
    const eur = seeded.users
      .find((user) => user.name === 'demo-customer-1')
      ?.accounts.find((account) => account.currency === 'EUR');
    const since = await daemonTime();
    const ids = Array.from({ length: 20 }, (_, index) => `rr-${String(index + 1)}`);
    const responses: E2eResponse[] = [];
    for (const id of ids) {
      responses.push(await getAccount(token, eur?.id ?? '', { headers: { 'x-request-id': id } }));
    }
    for (const response of responses) expect(response.status).toBe(200);

    // Every line of both replicas is JSON with the replica id of its container.
    for (const replica of REPLICAS) {
      const lines = await containerLogs(replica);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        const [parsed] = jsonLines([line]);
        expect(parsed, line).toBeDefined();
        expect(parsed?.['replicaId'], line).toBe(replica);
      }
    }

    // Each request is in the logs of exactly one replica, and each replica served at least 5.
    const served = await waitFor('the 20 reads in the replicas’ logs', async () => {
      const byReplica = await Promise.all(
        REPLICAS.map(async (replica) => {
          const reqIds = new Set(
            jsonLines(await containerLogs(replica, since)).map((line) => line['reqId']),
          );
          return ids.filter((id) => reqIds.has(id));
        }),
      );
      return byReplica.flat().length >= ids.length ? byReplica : undefined;
    });
    for (const id of ids) {
      expect(
        served.filter((list) => list.includes(id)),
        id,
      ).toHaveLength(1);
    }
    for (const list of served) expect(list.length).toBeGreaterThanOrEqual(5);

    // No response names a replica.
    for (const response of responses) {
      expect(Object.keys(response.headers).map((name) => name.toLowerCase())).not.toContain(
        'replicaid',
      );
      expect(hasMember(JSON.parse(response.body), 'replicaId')).toBe(false);
      const text = `${JSON.stringify(response.headers)}${response.body}`;
      expect(text).not.toContain('api-1');
      expect(text).not.toContain('api-2');
    }
  });
});
