import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { headerOf, problemOf, send } from './support/http.js';
import { ensureStack, restoreReplicas, stopServices } from './support/stack.js';
import { REPLICAS } from './support/urls.js';

describe('the load balancer without replicas', () => {
  beforeAll(ensureStack);
  // Whatever happened, the next file finds both replicas serving through nginx.
  afterAll(restoreReplicas);

  it('DEP-AC10 answers gateway errors as problem details, and serves again once the replicas are back', async () => {
    await stopServices(REPLICAS);

    const response = await send({
      url: '/health/live',
      headers: { 'x-request-id': 'gw-1' },
      timeoutMs: 60_000,
    });
    // 504 when nginx's connect timeout to each stopped replica ends the request, 502 once it has
    // marked both unavailable (DEP-AC10).
    expect([502, 504]).toContain(response.status);
    expect(headerOf(response, 'retry-after')).toBe('1');
    expect(headerOf(response, 'x-request-id')).toBe('gw-1');
    const problem = problemOf(response);
    expect(problem).toMatchObject({
      type: '/problems/upstream-unavailable',
      status: response.status,
      requestId: 'gw-1',
    });

    await restoreReplicas();
    const ready = await send({ url: '/health/ready' });
    expect(ready.status).toBe(200);
  });
});
