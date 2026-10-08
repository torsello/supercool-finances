import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { balanceOf, closePools, runtimePool } from '../../support/db.js';
import {
  bearer,
  createAccount,
  deposit,
  problemOf,
  type MovementJson,
} from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';
import { auditsOn, keyRowCount, reversalsOf, transactionsOn } from './support.js';

async function accountsOf(ownerId: string): Promise<string[]> {
  const result = await runtimePool().query<{ id: string }>(
    'SELECT id FROM accounts WHERE owner_id = $1',
    [ownerId],
  );
  return result.rows.map((row) => row.id);
}

/**
 * Sends raw bytes to the listening app and reads the answer until the server closes, so a header
 * can be sent twice exactly as a client would (plan 005 section 6).
 */
async function rawRequest(port: number, request: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    let answer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => (answer += chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      resolve(answer);
    });
    socket.write(request);
  });
}

describe('the Idempotency-Key is required and well formed', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('IDM-AC01 a deposit, a withdrawal, a transfer and a reversal without Idempotency-Key answer 400 and change nothing', async () => {
    const c1 = randomUUID();
    const c2 = randomUUID();
    const o1 = randomUUID();
    const c1Token = tokenFor(c1, 'customer');
    const o1Token = tokenFor(o1, 'operator');
    const a1 = await createAccount(built.app, c1Token, 'EUR');
    const b1 = await createAccount(built.app, tokenFor(c2, 'customer'), 'EUR');
    const d = (await deposit(built.app, o1Token, a1.id, '1000')).json<MovementJson>();

    const before = {
      a1: await transactionsOn(a1.id),
      b1: await transactionsOn(b1.id),
      auditsA1: await auditsOn(a1.id),
      auditsB1: await auditsOn(b1.id),
      keysC1: await keyRowCount(c1),
      keysO1: await keyRowCount(o1),
    };

    const requests = [
      {
        url: `/v1/accounts/${a1.id}/deposits`,
        token: o1Token,
        payload: { amount: '100', currency: 'EUR' },
      },
      {
        url: `/v1/accounts/${a1.id}/withdrawals`,
        token: c1Token,
        payload: { amount: '100', currency: 'EUR' },
      },
      {
        url: `/v1/accounts/${a1.id}/transfers`,
        token: c1Token,
        payload: { destinationAccountId: b1.id, amount: '100', currency: 'EUR' },
      },
      {
        url: `/v1/transactions/${d.id}/reversals`,
        token: o1Token,
        payload: { reason: 'Operator correction' },
      },
    ];
    for (const { url, token, payload } of requests) {
      const response = await built.app.inject({
        method: 'POST',
        url,
        headers: bearer(token),
        payload,
      });
      expect(response.statusCode, url).toBe(400);
      expect(problemOf(response).type, url).toBe('/problems/malformed-request');
    }

    expect(await balanceOf(a1.id)).toBe('1000');
    expect(await balanceOf(b1.id)).toBe('0');
    expect(await reversalsOf(d.id)).toEqual([]);
    expect({
      a1: await transactionsOn(a1.id),
      b1: await transactionsOn(b1.id),
      auditsA1: await auditsOn(a1.id),
      auditsB1: await auditsOn(b1.id),
      keysC1: await keyRowCount(c1),
      keysO1: await keyRowCount(o1),
    }).toEqual(before);
  });

  it('IDM-AC03 a malformed key answers 400 on account creation and on a withdrawal, a key sent twice included, and changes nothing', async () => {
    const c1 = randomUUID();
    const c1Token = tokenFor(c1, 'customer');
    const a1 = await createAccount(built.app, c1Token, 'EUR');
    await deposit(built.app, tokenFor(randomUUID(), 'operator'), a1.id, '1000');
    const transactionsBefore = await transactionsOn(a1.id);

    const created = await built.app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { ...bearer(c1Token), 'idempotency-key': 'bad key' },
      payload: { currency: 'EUR' },
    });
    expect(created.statusCode).toBe(400);
    expect(problemOf(created).type).toBe('/problems/malformed-request');

    const long = await built.app.inject({
      method: 'POST',
      url: `/v1/accounts/${a1.id}/withdrawals`,
      headers: { ...bearer(c1Token), 'idempotency-key': 'x'.repeat(256) },
      payload: { amount: '100', currency: 'EUR' },
    });
    expect(long.statusCode).toBe(400);
    expect(problemOf(long).type).toBe('/problems/malformed-request');

    const tcp = buildProductionApp();
    await tcp.app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const address = tcp.app.server.address();
      if (address === null || typeof address === 'string') throw new Error('no TCP address');
      const body = JSON.stringify({ amount: '100', currency: 'EUR' });
      const answer = await rawRequest(
        address.port,
        `POST /v1/accounts/${a1.id}/withdrawals HTTP/1.1\r\n` +
          'Host: localhost\r\n' +
          `Authorization: Bearer ${c1Token}\r\n` +
          'Idempotency-Key: k1\r\n' +
          'Idempotency-Key: k2\r\n' +
          'Content-Type: application/json\r\n' +
          `Content-Length: ${String(Buffer.byteLength(body))}\r\n` +
          'Connection: close\r\n\r\n' +
          body,
      );
      const [head = '', payload = ''] = answer.split('\r\n\r\n');
      expect(head).toMatch(/^HTTP\/1\.1 400 /);
      expect(head.toLowerCase()).toContain('content-type: application/problem+json');
      expect((JSON.parse(payload) as { type: string }).type).toBe('/problems/malformed-request');
    } finally {
      await tcp.app.close();
    }

    expect(await accountsOf(c1)).toEqual([a1.id]);
    expect(await balanceOf(a1.id)).toBe('1000');
    expect(await transactionsOn(a1.id)).toEqual(transactionsBefore);
    expect(await keyRowCount(c1)).toBe(0);
  });
});
