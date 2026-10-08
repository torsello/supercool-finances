import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { createAccount, deposit } from '../../support/http.js';
import { LOG_LEVEL } from '../../support/logs.js';
import { tokenFor } from '../../support/tokens.js';

describe('a client that aborts mid-body (SYS-R25, SYS-R26)', () => {
  let built: BuiltApp;
  let port: number;
  /** The status each request was answered with, by correlation id, read before it is sent. */
  const answered = new Map<string, number>();

  beforeAll(async () => {
    built = buildProductionApp();
    built.app.addHook('onSend', (request, reply, payload, done) => {
      answered.set(request.id, reply.statusCode);
      done(null, payload);
    });
    await built.app.listen({ host: '127.0.0.1', port: 0 });
    const address = built.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no TCP address');
    port = address.port;
  });

  afterAll(async () => {
    await built.app.close();
  });

  /** Resolves with the status the request with `reqId` was answered with. */
  async function answerOf(reqId: string): Promise<number> {
    const deadline = Date.now() + 5000;
    for (;;) {
      const status = answered.get(reqId);
      if (status !== undefined) return status;
      if (Date.now() >= deadline) throw new Error(`request ${reqId} was never answered`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it('SYS-R25 SYS-R26 answers a body cut short by the client as a malformed request and logs no error', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const a1 = await createAccount(built.app, c1);
    expect(
      (await deposit(built.app, tokenFor(randomUUID(), 'operator'), a1.id, '1000')).statusCode,
    ).toBe(201);

    built.logs.clear();
    await new Promise<void>((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port }, () => {
        socket.write(
          `POST /v1/accounts/${a1.id}/withdrawals HTTP/1.1\r\n` +
            'Host: 127.0.0.1\r\n' +
            `Authorization: Bearer ${c1}\r\n` +
            `Idempotency-Key: ${randomUUID()}\r\n` +
            'X-Request-Id: req-aborted\r\n' +
            'Content-Type: application/json\r\n' +
            'Content-Length: 1000\r\n\r\n' +
            '{"amount":',
          () => {
            socket.end();
            socket.destroy();
            resolve();
          },
        );
      });
      socket.on('error', reject);
    });
    expect(await answerOf('req-aborted')).toBe(400);
    const errors = built.logs.lines().filter((line) => (line.level ?? 0) >= LOG_LEVEL.error);
    expect(errors).toEqual([]);
  });
});
