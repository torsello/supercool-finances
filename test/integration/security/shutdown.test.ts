import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { promisify } from 'node:util';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_CURSOR_SECRET } from '../../support/app.js';
import { blockedBackends } from '../../support/backends.js';
import {
  balanceOf,
  closePools,
  createCustomerAccount,
  runtimePool,
  writeDirectDeposit,
} from '../../support/db.js';
import { requireEnv } from '../../support/env.js';
import { freePort } from '../../support/ports.js';
import { openLockSession } from '../../support/sessions.js';
import { K, TEST_AUDIENCE, TEST_ISSUER, tokenFor } from '../../support/tokens.js';

const run = promisify(execFile);

interface Answer {
  status: number;
  body: string;
}

/** One request on a connection of its own, closed afterwards. */
async function send(
  port: number,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<Answer> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path,
        agent: false,
        headers: { connection: 'close', ...options.headers },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (body += chunk));
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body });
        });
      },
    );
    request.on('error', reject);
    request.end(options.body);
  });
}

/** Whether a new TCP connection to `port` is refused. */
async function refused(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code === 'ECONNREFUSED');
    });
  });
}

/** Polls `check` every 20 ms until it holds, failing after `timeoutMs`. */
async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The ids of the clients Redis lists, other than the caller's own connection. */
async function redisClients(redis: Redis): Promise<string[]> {
  const own = String(await redis.client('ID'));
  const list = String(await redis.client('LIST'));
  return list
    .split('\n')
    .map((line) => /(?:^| )id=(\d+)/.exec(line)?.[1])
    .filter((id): id is string => id !== undefined && id !== own)
    .sort();
}

describe('graceful shutdown of the production build', () => {
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis(requireEnv('REDIS_URL'), { maxRetriesPerRequest: 1 });
    await run('npm', ['run', 'build'], { timeout: 120_000 });
  }, 120_000);

  afterAll(async () => {
    await redis.quit();
    await closePools();
  });

  it('SEC-AC20 drains, stops accepting, lets the request in flight finish, closes every connection and exits 0', async () => {
    const port = await freePort();
    const applicationName = `scf-shutdown-${randomBytes(4).toString('hex')}`;
    const databaseUrl = new URL(requireEnv('TEST_DATABASE_URL'));
    databaseUrl.searchParams.set('application_name', applicationName);
    const clientsBefore = await redisClients(redis);

    const child = spawn(process.execPath, ['dist/main.js'], {
      env: {
        PATH: process.env['PATH'],
        DATABASE_URL: databaseUrl.toString(),
        REDIS_URL: requireEnv('REDIS_URL'),
        JWT_SECRET: K,
        JWT_ISSUER: TEST_ISSUER,
        JWT_AUDIENCE: TEST_AUDIENCE,
        CURSOR_SECRET: TEST_CURSOR_SECRET,
        PORT: String(port),
        METRICS_PORT: String(await freePort()),
        ACCOUNT_LOCK_TIMEOUT_MS: '4000',
        SHUTDOWN_DRAIN_DELAY_MS: '1000',
        REQUEST_TIMEOUT_MS: '40000',
        SHUTDOWN_TIMEOUT_MS: '40000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    const exit = new Promise<{ code: number | null; at: number }>((resolve) => {
      child.once('exit', (code) => {
        resolve({ code, at: performance.now() });
      });
    });

    const session = await openLockSession();
    try {
      await until(async () => !(await refused(port)), 'the service to listen');
      const c1Id = randomUUID();
      const a1 = await createCustomerAccount({ currency: 'EUR', ownerId: c1Id });
      await writeDirectDeposit(a1, '1000');
      await session.lockRow('accounts', a1.id);

      const r1 = send(port, {
        method: 'POST',
        path: `/v1/accounts/${a1.id}/withdrawals`,
        headers: {
          authorization: `Bearer ${tokenFor(c1Id, 'customer')}`,
          'idempotency-key': randomUUID(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ amount: '100', currency: 'EUR' }),
      }).then((answer) => ({ ...answer, at: performance.now() }));
      await blockedBackends({ count: 1, by: session.pid });

      child.kill('SIGTERM');
      let ready: Answer = { status: 0, body: '' };
      await until(async () => {
        ready = await send(port, { path: '/health/ready' });
        return ready.status === 503;
      }, 'readiness to answer 503');
      expect((JSON.parse(ready.body) as { type: string }).type).toBe(
        '/problems/service-unavailable',
      );
      expect((await send(port, { path: '/health/live' })).status).toBe(200);

      await until(() => output.includes('stopped accepting connections'), 'the stop line');
      expect(await refused(port)).toBe(true);

      await session.release();
      const answered = await r1;
      expect(answered.status).toBe(201);
      expect((JSON.parse(answered.body) as { balance: string }).balance).toBe('900');
      const exited = await exit;
      expect(exited.code).toBe(0);
      expect(exited.at).toBeGreaterThanOrEqual(answered.at);
      expect(await balanceOf(a1.id)).toBe('900');

      await until(async () => {
        const sessions = await runtimePool().query(
          'SELECT 1 FROM pg_stat_activity WHERE application_name = $1',
          [applicationName],
        );
        return sessions.rowCount === 0;
      }, 'the database sessions to end');
      await until(
        async () => (await redisClients(redis)).join() === clientsBefore.join(),
        'the Redis client to disconnect',
      );
    } finally {
      child.kill('SIGKILL');
      await session.close();
    }
  });

  it('SEC-R25 a second signal during the shutdown is logged at warn and ignored: the shutdown runs to its end and exits 0', async () => {
    const port = await freePort();
    const child = spawn(process.execPath, ['dist/main.js'], {
      env: {
        PATH: process.env['PATH'],
        DATABASE_URL: requireEnv('TEST_DATABASE_URL'),
        REDIS_URL: requireEnv('REDIS_URL'),
        JWT_SECRET: K,
        JWT_ISSUER: TEST_ISSUER,
        JWT_AUDIENCE: TEST_AUDIENCE,
        CURSOR_SECRET: TEST_CURSOR_SECRET,
        PORT: String(port),
        METRICS_PORT: String(await freePort()),
        SHUTDOWN_DRAIN_DELAY_MS: '1000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    const exit = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => {
        resolve(code);
      });
    });
    try {
      await until(async () => !(await refused(port)), 'the service to listen');
      child.kill('SIGTERM');
      await until(
        async () => (await send(port, { path: '/health/ready' })).status === 503,
        'readiness to answer 503',
      );
      child.kill('SIGINT');
      await until(() => output.includes('ignored'), 'the second signal to be logged');

      expect(await exit).toBe(0);
      const lines = output
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as { level: number; msg: string; signal?: string });
      expect(lines.filter((line) => line.signal === 'SIGINT')).toEqual([
        expect.objectContaining({ level: 40 }),
      ]);
      expect(lines.some((line) => line.msg === 'shutdown complete')).toBe(true);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('SEC-R25 SEC-R27 while closing, a request in flight on a kept-alive connection completes with Connection: close, a request that arrives after the stop gets 503 at once, and the shutdown exits 0', async () => {
    const port = await freePort();
    const child = spawn(process.execPath, ['dist/main.js'], {
      env: {
        PATH: process.env['PATH'],
        DATABASE_URL: requireEnv('TEST_DATABASE_URL'),
        REDIS_URL: requireEnv('REDIS_URL'),
        JWT_SECRET: K,
        JWT_ISSUER: TEST_ISSUER,
        JWT_AUDIENCE: TEST_AUDIENCE,
        CURSOR_SECRET: TEST_CURSOR_SECRET,
        PORT: String(port),
        METRICS_PORT: String(await freePort()),
        ACCOUNT_LOCK_TIMEOUT_MS: '4000',
        SHUTDOWN_DRAIN_DELAY_MS: '500',
        REQUEST_TIMEOUT_MS: '40000',
        SHUTDOWN_TIMEOUT_MS: '40000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    const exit = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => {
        resolve(code);
      });
    });

    /** A kept-alive connection, with everything it received. */
    async function keptAlive() {
      const socket = connect({ host: '127.0.0.1', port });
      const state = { received: '', closed: false };
      socket.on('data', (chunk: Buffer) => (state.received += chunk.toString('latin1')));
      socket.on('close', () => (state.closed = true));
      socket.on('error', () => undefined);
      await new Promise<void>((resolve) => {
        socket.once('connect', () => {
          resolve();
        });
      });
      return { socket, state };
    }

    const session = await openLockSession();
    try {
      await until(async () => !(await refused(port)), 'the service to listen');
      const c1Id = randomUUID();
      const c1 = tokenFor(c1Id, 'customer');
      const a1 = await createCustomerAccount({ currency: 'EUR', ownerId: c1Id });
      await writeDirectDeposit(a1, '1000');
      await session.lockRow('accounts', a1.id);

      // Connection A: a withdrawal waiting on A1's lock through the shutdown.
      const a = await keptAlive();
      const body = JSON.stringify({ amount: '100', currency: 'EUR' });
      a.socket.write(
        `POST /v1/accounts/${a1.id}/withdrawals HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
          `Authorization: Bearer ${c1}\r\nIdempotency-Key: ${randomUUID()}\r\n` +
          `Content-Type: application/json\r\nContent-Length: ${String(body.length)}\r\n\r\n${body}`,
      );
      await blockedBackends({ count: 1, by: session.pid });

      // Connection B: one request answered and kept alive, then the next request started.
      const b = await keptAlive();
      b.socket.write('GET /health/live HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
      await until(() => b.state.received.includes('{"status":"ok"}'), 'the first answer on B');
      expect(b.state.received.toLowerCase()).not.toContain('connection: close');
      b.state.received = '';
      b.socket.write(`GET /v1/accounts/${a1.id} HTTP/1.1\r\nHost: 127.0.0.1\r\n`);

      child.kill('SIGTERM');
      await until(() => output.includes('stopped accepting connections'), 'the stop line');
      expect(b.state.closed).toBe(false);
      b.socket.write(`Authorization: Bearer ${c1}\r\n\r\n`);
      await until(() => b.state.received.includes('\r\n\r\n'), 'the answer after the stop');
      const [head = '', answer = ''] = b.state.received.split('\r\n\r\n');
      expect(head.split('\r\n')[0]).toBe('HTTP/1.1 503 Service Unavailable');
      expect(head.toLowerCase()).toContain('connection: close');
      expect(head.toLowerCase()).toContain('retry-after: 1');
      expect((JSON.parse(answer) as { type: string }).type).toBe('/problems/service-unavailable');
      await until(() => b.state.closed, 'B to close');

      await session.release();
      await until(() => a.state.received.includes('"balance"'), 'the withdrawal on A');
      expect(a.state.received.split('\r\n')[0]).toBe('HTTP/1.1 201 Created');
      expect(a.state.received.toLowerCase()).toContain('connection: close');
      await until(() => a.state.closed, 'A to close');

      expect(await exit).toBe(0);
      expect(await balanceOf(a1.id)).toBe('900');
    } finally {
      child.kill('SIGKILL');
      await session.close();
    }
  });
});
