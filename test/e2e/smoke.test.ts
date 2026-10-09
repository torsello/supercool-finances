import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { send } from './support/http.js';
import {
  containerLogs,
  daemonTime,
  ensureStack,
  waitForBothReplicasThroughNginx,
} from './support/stack.js';
import { REPLICAS } from './support/urls.js';
import { waitFor } from './support/wait.js';

describe('the stack', () => {
  beforeAll(async () => {
    await ensureStack();
    await waitForBothReplicasThroughNginx();
  });

  it('answers through nginx from both replicas', async () => {
    const since = await daemonTime();
    const prefix = `smoke-${randomUUID()}`;
    for (let index = 1; index <= 10; index += 1) {
      const response = await send({
        url: '/health/ready',
        headers: { 'x-request-id': `${prefix}-${String(index)}` },
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ status: 'ready' });
    }
    // Docker collects the logs on its own schedule: wait until both replicas' lines are there.
    const served = await waitFor('the smoke requests in the replicas’ logs', async () => {
      const counts = await Promise.all(
        REPLICAS.map(
          async (replica) =>
            (await containerLogs(replica, since)).filter(
              (line) => line.includes(prefix) && line.includes('request completed'),
            ).length,
        ),
      );
      return counts.reduce((sum, count) => sum + count, 0) === 10 ? counts : undefined;
    });
    for (const count of served) expect(count).toBeGreaterThan(0);
  });
});
