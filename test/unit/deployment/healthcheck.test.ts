import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { checkLiveness } from '../../../src/platform/health/liveness-probe.js';

const servers: Server[] = [];

/** A server on 127.0.0.1 that answers `/health/live` with `status`, or never when undefined. */
async function serve(status: number | undefined): Promise<number> {
  const server = createServer((request, response) => {
    if (status === undefined) return;
    response.statusCode = request.url === '/health/live' ? status : 404;
    response.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/** A port nothing listens on: one that was free a moment ago. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return port;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});

describe('the container healthcheck', () => {
  it('DEP-R21 exits 0 when /health/live answers 200', async () => {
    expect(await checkLiveness({ port: String(await serve(200)) })).toBe(0);
  });

  it('DEP-R21 exits 1 on another status, no answer in time, a refused connection or an invalid PORT', async () => {
    expect(await checkLiveness({ port: String(await serve(503)) })).toBe(1);
    expect(await checkLiveness({ port: String(await serve(undefined)), timeoutMs: 200 })).toBe(1);
    expect(await checkLiveness({ port: String(await closedPort()) })).toBe(1);
    for (const port of ['', '0', '65536', 'abc']) expect(await checkLiveness({ port })).toBe(1);
  });

  it('DEP-R21 the script requests /health/live on PORT and sets its exit code', async () => {
    const run = (port: number): Promise<number | null> =>
      new Promise((resolve, reject) => {
        const child = spawn('npx', ['tsx', 'src/healthcheck.ts'], {
          env: { ...process.env, PORT: String(port) },
          stdio: 'ignore',
        });
        child.on('error', reject);
        child.on('close', resolve);
      });

    expect(await run(await serve(200))).toBe(0);
    expect(await run(await serve(500))).toBe(1);
  }, 30_000);
});
