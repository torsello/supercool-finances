import { randomUUID } from 'node:crypto';
import { connect, type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { blockedBackends } from '../../support/backends.js';
import { closePools, createCustomerAccount, writeDirectDeposit } from '../../support/db.js';
import { LOG_LEVEL } from '../../support/logs.js';
import { openLockSession } from '../../support/sessions.js';
import { tokenFor } from '../../support/tokens.js';
import { keyRecord } from '../movements/support.js';

/**
 * Timeouts short enough for a test and within the budget of SEC-R35: 100 + 100 + 3 × (100 + 2 ×
 * 100) + 30 = 1130 ms, below a request timeout of 1500 ms.
 */
const SHORT = {
  DB_POOL_ACQUIRE_TIMEOUT_MS: '100',
  REDIS_COMMAND_TIMEOUT_MS: '100',
  IDEMPOTENCY_WAIT_TIMEOUT_MS: '100',
  ACCOUNT_LOCK_TIMEOUT_MS: '100',
  REQUEST_TIMEOUT_MS: '1500',
  SHUTDOWN_TIMEOUT_MS: '1500',
};

/** Polls `check` every 10 ms until it holds, failing after `timeoutMs`. */
async function until(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('the request timeout before the handler', () => {
  let built: BuiltApp;
  let port: number;

  beforeAll(async () => {
    built = buildProductionApp({ env: SHORT });
    await built.app.listen({ port: 0, host: '127.0.0.1' });
    port = (built.app.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('SEC-R33 a body still arriving at REQUEST_TIMEOUT_MS gets one 503 with Connection: close at the deadline, the handler never runs, nothing is logged as an error and the request stops being tracked', async () => {
    const c1Id = randomUUID();
    const a1 = await createCustomerAccount({ currency: 'EUR', ownerId: c1Id });
    const key = randomUUID();
    built.logs.clear();

    const socket = connect({ host: '127.0.0.1', port });
    let received = '';
    let closedAt: number | undefined;
    socket.on('data', (chunk: Buffer) => (received += chunk.toString('latin1')));
    socket.on('close', () => (closedAt = performance.now()));
    socket.on('error', () => undefined);
    await new Promise<void>((resolve) => {
      socket.once('connect', () => {
        resolve();
      });
    });
    const sentAt = performance.now();
    socket.write(
      `POST /v1/accounts/${a1.id}/withdrawals HTTP/1.1\r\n` +
        'Host: 127.0.0.1\r\n' +
        `Authorization: Bearer ${tokenFor(c1Id, 'customer')}\r\n` +
        `Idempotency-Key: ${key}\r\n` +
        'Content-Type: application/json\r\n' +
        'Content-Length: 100\r\n\r\n' +
        '{"amount":',
    );

    await until(() => received.includes('\r\n\r\n'), 'the answer');
    const answeredAt = performance.now();
    await until(() => closedAt !== undefined, 'the server to close the connection');

    expect(answeredAt - sentAt).toBeGreaterThanOrEqual(1500);
    expect(answeredAt - sentAt).toBeLessThan(3000);
    expect(received.match(/HTTP\/1\.1 /g)).toHaveLength(1);
    const [head = '', body = ''] = received.split('\r\n\r\n');
    expect(head.split('\r\n')[0]).toBe('HTTP/1.1 503 Service Unavailable');
    expect(head.toLowerCase()).toContain('connection: close');
    expect(head.toLowerCase()).toContain('retry-after: 1');
    expect((JSON.parse(body) as { type: string }).type).toBe('/problems/service-unavailable');

    await until(() => built.app.work.size === 0, 'the request to stop being tracked');
    expect(await keyRecord(c1Id, key)).toBeUndefined();
    const errors = built.logs.lines().filter((line) => (line.level ?? 0) >= LOG_LEVEL.error);
    expect(errors).toEqual([]);
    expect(built.logs.lines().some((line) => /already sent/i.test(JSON.stringify(line)))).toBe(
      false,
    );
  });

  it('SEC-R27 a client that disconnects while its withdrawal waits on a lock leaves the request tracked until its database work ends', async () => {
    const c1Id = randomUUID();
    const a1 = await createCustomerAccount({ currency: 'EUR', ownerId: c1Id });
    await writeDirectDeposit(a1, '1000');
    // The default lock timeout of 2000 ms, so the withdrawal is still waiting when the client goes.
    const defaults = buildProductionApp();
    await defaults.app.listen({ port: 0, host: '127.0.0.1' });
    const defaultsPort = (defaults.app.server.address() as AddressInfo).port;
    const session = await openLockSession();
    try {
      await session.lockRow('accounts', a1.id);
      const socket = connect({ host: '127.0.0.1', port: defaultsPort });
      socket.on('error', () => undefined);
      await new Promise<void>((resolve) => {
        socket.once('connect', () => {
          resolve();
        });
      });
      const body = JSON.stringify({ amount: '100', currency: 'EUR' });
      socket.write(
        `POST /v1/accounts/${a1.id}/withdrawals HTTP/1.1\r\n` +
          'Host: 127.0.0.1\r\n' +
          `Authorization: Bearer ${tokenFor(c1Id, 'customer')}\r\n` +
          `Idempotency-Key: ${randomUUID()}\r\n` +
          'Content-Type: application/json\r\n' +
          `Content-Length: ${String(Buffer.byteLength(body))}\r\n\r\n` +
          body,
      );
      await blockedBackends({ count: 1, by: session.pid });
      socket.destroy();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // The client is gone, but its withdrawal still waits on A1's lock with a pool connection.
      expect(defaults.app.work.size).toBe(1);
      await session.release();
      await until(() => defaults.app.work.size === 0, 'the database work to end');
    } finally {
      await session.close();
      await defaults.app.close();
    }
  });
});
