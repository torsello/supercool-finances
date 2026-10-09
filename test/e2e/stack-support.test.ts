import http from 'node:http';
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { freePort } from '../support/ports.js';
import { run, runOk } from './support/command.js';
import { send, type E2eRequest } from './support/http.js';
import { readRecord } from './support/recorder.js';
import { MAX_RETRIES, sendWithRetries } from './support/retrying-client.js';
import {
  assertPortsFree,
  assertSubnetFree,
  downStack,
  LONG_RUNNING,
  overlaps,
  PROJECT,
  projectContainers,
  serviceStates,
  stackHostPorts,
  startStack,
  SUBNET,
  SUBNET_PREFIX,
} from './support/stack.js';

/**
 * Every container and volume of Docker that is not the e2e project's, with its state. A volume is
 * the project's when it has its label or a container of the project mounts it: the anonymous
 * volume of an image's VOLUME, such as Redis's /data, has no label.
 */
async function othersInDocker(): Promise<{ containers: string[]; volumes: string[] }> {
  const mounted = new Set(
    (await projectContainers()).flatMap((container) =>
      (container.Mounts ?? []).flatMap((mount) => (mount.Name === undefined ? [] : [mount.Name])),
    ),
  );
  const containers = await runOk('docker', [
    'ps',
    '--all',
    '--format',
    '{{.ID}} {{.State}} {{.Label "com.docker.compose.project"}}',
  ]);
  const volumes = await runOk('docker', [
    'volume',
    'ls',
    '--format',
    '{{.Name}} {{.Label "com.docker.compose.project"}}',
  ]);
  const notOurs = (line: string): boolean => line !== '' && !line.endsWith(` ${PROJECT}`);
  return {
    containers: containers.stdout.split('\n').filter(notOurs).sort(),
    volumes: volumes.stdout
      .split('\n')
      .filter(notOurs)
      .filter((line) => !mounted.has(line.split(' ')[0] ?? ''))
      .sort(),
  };
}

async function projectVolumes(): Promise<string[]> {
  const result = await runOk('docker', [
    'volume',
    'ls',
    '--quiet',
    '--filter',
    `label=com.docker.compose.project=${PROJECT}`,
  ]);
  return result.stdout.split('\n').filter((name) => name !== '');
}

describe('the e2e stack harness (plan 008 section 5)', () => {
  it('starts and stops a stack of its own project only, leaving every other container and volume as it was', async () => {
    const before = await othersInDocker();
    try {
      await startStack({ fresh: true });

      const states = await serviceStates();
      for (const service of LONG_RUNNING) {
        const state = states.find((item) => item.Service === service);
        expect(state, service).toMatchObject({ State: 'running', Health: 'healthy' });
      }
      const containers = await projectContainers();
      expect(containers.length).toBeGreaterThanOrEqual(LONG_RUNNING.length);
      for (const container of containers) {
        expect(container.Name).toMatch(new RegExp(`^/${PROJECT}-`));
      }
      expect(await projectVolumes()).toEqual([`${PROJECT}_postgres-data`]);
      expect(await othersInDocker()).toEqual(before);
    } finally {
      await downStack();
    }
    expect(await projectContainers()).toEqual([]);
    expect(await projectVolumes()).toEqual([]);
    expect(await othersInDocker()).toEqual(before);
  });

  it('refuses to start while a host port of the stack is taken, naming the port', async () => {
    const server: Server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(3001, '127.0.0.1', resolve);
    });
    try {
      await expect(assertPortsFree()).rejects.toThrow(/port 3001 /);
    } finally {
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    }
    await expect(assertPortsFree()).resolves.toBeUndefined();
  });

  it('DEP-R42 checks that the observability profile can start too: refuses to start while Grafana’s port 3030 is taken', async () => {
    expect(stackHostPorts()).toContain(3030);
    const server: Server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(3030, '127.0.0.1', resolve);
    });
    try {
      await expect(assertPortsFree()).rejects.toThrow(/port 3030 /);
    } finally {
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    }
    await expect(assertPortsFree()).resolves.toBeUndefined();
  });

  it('refuses to start while another Docker network uses its subnet', async () => {
    const name = `${PROJECT}-subnet-probe`;
    await runOk('docker', ['network', 'create', '--subnet', `${SUBNET_PREFIX}.0/25`, name]);
    try {
      expect(overlaps(`${SUBNET_PREFIX}.0/25`, SUBNET)).toBe(true);
      await expect(assertSubnetFree()).rejects.toThrow(new RegExp(name));
    } finally {
      await run('docker', ['network', 'rm', name]);
    }
    await expect(assertSubnetFree()).resolves.toBeUndefined();
  });
});

/** One scripted answer of the fake server: a status with headers and a body, or a reset. */
type Answer = { status: number; headers?: Record<string, string>; body?: string } | 'reset';

/**
 * A server of the test's own, standing in for the stack: it answers the requests it receives with
 * `answers` in turn, the last one again once they run out, and records each request.
 */
async function fakeServer(answers: readonly Answer[]): Promise<{
  url: string;
  received: { key: string | undefined; body: string }[];
  close: () => Promise<void>;
}> {
  const received: { key: string | undefined; body: string }[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const key = request.headers['idempotency-key'];
      received.push({
        key: Array.isArray(key) ? key.join(',') : key,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const answer = answers[Math.min(received.length, answers.length) - 1] ?? 'reset';
      if (answer === 'reset') {
        request.socket.destroy();
        return;
      }
      response.writeHead(answer.status, {
        'content-type': 'application/problem+json',
        ...answer.headers,
      });
      response.end(answer.body ?? '{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/v1/accounts/a/withdrawals`,
    received,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    },
  };
}

const problem = (type: string): string => JSON.stringify({ type, status: 409 });

/** A withdrawal with its own key, sent to `url` and never recorded: the server is the test's. */
function withdrawal(url: string): E2eRequest {
  return {
    method: 'POST',
    url,
    headers: { 'idempotency-key': 'k-retry-1' },
    body: { amount: '100', currency: 'EUR' },
    record: false,
  };
}

/** The injected sleep: records each wait and returns at once. */
function recordingSleep(): { waits: number[]; sleep: (ms: number) => Promise<void> } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
      await Promise.resolve();
    },
  };
}

describe('the retrying client of section 1.5 of spec 008', () => {
  const servers: { close: () => Promise<void> }[] = [];
  afterAll(async () => {
    await Promise.all(
      servers.map(async (server) => {
        await server.close();
      }),
    );
  });

  it('DEP-R17 retries a connection error, a 502, 503 and 504 and a 409 request in progress with the same key and body, waiting Retry-After or else 200 ms', async () => {
    const server = await fakeServer([
      'reset',
      { status: 502, headers: { 'retry-after': '1' } },
      { status: 503 },
      { status: 504, headers: { 'retry-after': '2' } },
      {
        status: 409,
        headers: { 'retry-after': '1' },
        body: problem('/problems/request-in-progress'),
      },
      { status: 201, body: '{"id":"t1"}' },
    ]);
    servers.push(server);
    const { waits, sleep } = recordingSleep();

    const result = await sendWithRetries(withdrawal(server.url), { sleep });

    expect(result.final.status).toBe(201);
    expect(result.final.body).toBe('{"id":"t1"}');
    expect(result.attempts).toEqual(['ECONNRESET', 502, 503, 504, 409, 201]);
    expect(waits).toEqual([200, 1000, 200, 2000, 1000]);
    expect(result.delaysMs).toEqual(waits);
    expect(server.received).toHaveLength(6);
    for (const request of server.received) {
      expect(request).toEqual({ key: 'k-retry-1', body: '{"amount":"100","currency":"EUR"}' });
    }
  });

  it.each([
    [400, '/problems/malformed-request'],
    [401, '/problems/unauthenticated'],
    [403, '/problems/forbidden'],
    [404, '/problems/not-found'],
    [409, '/problems/account-not-active'],
    [413, '/problems/payload-too-large'],
    [415, '/problems/unsupported-media-type'],
    [422, '/problems/insufficient-funds'],
    [429, '/problems/rate-limited'],
  ])('DEP-R17 never retries a %i with type %s', async (status, type) => {
    const server = await fakeServer([
      { status, headers: { 'retry-after': '1' }, body: problem(type) },
    ]);
    servers.push(server);
    const { waits, sleep } = recordingSleep();

    const result = await sendWithRetries(withdrawal(server.url), { sleep });

    expect(result.final.status).toBe(status);
    expect(result.attempts).toEqual([status]);
    expect(waits).toEqual([]);
    expect(server.received).toHaveLength(1);
  });

  it('DEP-R17 treats a 201 and a 422 as final answers', async () => {
    for (const status of [201, 422]) {
      const server = await fakeServer([{ status, body: '{}' }]);
      servers.push(server);
      const result = await sendWithRetries(withdrawal(server.url), recordingSleep());
      expect(result.attempts).toEqual([status]);
    }
  });

  it('DEP-R17 sends a request at most 60 times again, then keeps the last answer', async () => {
    const server = await fakeServer([{ status: 503, headers: { 'retry-after': '1' } }]);
    servers.push(server);
    const { waits, sleep } = recordingSleep();

    const result = await sendWithRetries(withdrawal(server.url), { sleep });

    expect(MAX_RETRIES).toBe(60);
    expect(result.final.status).toBe(503);
    expect(server.received).toHaveLength(61);
    expect(waits).toEqual(Array.from({ length: 60 }, () => 1000));
  });

  it('DEP-R17 fails when even the last of 61 attempts finds no server', async () => {
    const port = await freePort();
    const { waits, sleep } = recordingSleep();

    await expect(
      sendWithRetries(withdrawal(`http://127.0.0.1:${String(port)}/v1/accounts/a/withdrawals`), {
        sleep,
      }),
    ).rejects.toThrow(/no answer after 61 attempts: ECONNREFUSED/);
    expect(waits).toEqual(Array.from({ length: 60 }, () => 200));
  });

  it('records no response of a server of the test’s own in the response record', async () => {
    const server = await fakeServer([{ status: 204 }]);
    servers.push(server);
    const before = readRecord().length;
    const response = await send({ url: server.url, record: false });
    expect(response.status).toBe(204);
    expect(readRecord()).toHaveLength(before);
  });
});
