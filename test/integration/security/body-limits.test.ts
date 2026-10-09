import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp, SPEC_007_DEFAULTS } from '../../support/app.js';
import { balanceOf, closePools } from '../../support/db.js';
import { bearer, changeStatus, createAccount, deposit, problemOf } from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';
import { keyRecord, transactionsOfKind } from '../movements/support.js';

/** The withdrawal body of these ACs, padded with trailing spaces to exactly `bytes` bytes. */
function padded(bytes: number): string {
  const body = JSON.stringify({ amount: '100', currency: 'EUR' });
  return body.padEnd(bytes, ' ');
}

/** A response as `node:http` received it. */
interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

describe('request bodies', () => {
  let built: BuiltApp;
  let port: number;

  beforeAll(async () => {
    built = buildProductionApp({ env: SPEC_007_DEFAULTS });
    await built.app.listen({ port: 0, host: '127.0.0.1' });
    port = (built.app.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  /**
   * Sends `body` in chunks of 1000 bytes with chunked transfer encoding and no `Content-Length`,
   * over a real connection, so the service can only count the bytes it receives.
   */
  async function chunked(path: string, headers: Record<string, string>, body: string) {
    return await new Promise<RawResponse>((resolve, reject) => {
      const request = httpRequest(
        { host: '127.0.0.1', port, method: 'POST', path, headers },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
          response.on('error', reject);
        },
      );
      // The service may answer and stop reading before every chunk is written.
      request.on('error', reject);
      for (let offset = 0; offset < body.length; offset += 1000) {
        request.write(body.slice(offset, offset + 1000));
      }
      request.end();
    });
  }

  it('SEC-AC07 a body of exactly 16384 bytes is applied; above it, by Content-Length or by the bytes of a chunked body, it answers 413 and writes nothing', async () => {
    const c1Id = randomUUID();
    const c1 = tokenFor(c1Id, 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, c1, 'EUR');
    expect((await deposit(built.app, o1, a1.id, '1000')).statusCode).toBe(201);
    const [k1, k2, k3] = [randomUUID(), randomUUID(), randomUUID()];
    const url = `/v1/accounts/${a1.id}/withdrawals`;
    const headers = (key: string) => ({
      ...bearer(c1),
      'idempotency-key': key,
      'content-type': 'application/json',
    });

    expect(Buffer.byteLength(padded(16384))).toBe(16384);
    const atLimit = await built.app.inject({
      method: 'POST',
      url,
      headers: headers(k1),
      payload: padded(16384),
    });
    expect(atLimit.statusCode).toBe(201);

    const above = await built.app.inject({
      method: 'POST',
      url,
      headers: headers(k2),
      payload: padded(16385),
    });
    expect(above.statusCode).toBe(413);
    expect(problemOf(above).type).toBe('/problems/payload-too-large');

    const streamed = await chunked(url, headers(k3), padded(20000));
    expect(streamed.status).toBe(413);
    expect(streamed.headers['content-type']).toBe('application/problem+json');
    expect(streamed.headers['content-length']).toBeDefined();
    expect((JSON.parse(streamed.body) as { type: string }).type).toBe(
      '/problems/payload-too-large',
    );

    expect(await balanceOf(a1.id)).toBe('900');
    expect(await transactionsOfKind(a1.id, 'withdrawal')).toHaveLength(1);
    expect(await keyRecord(c1Id, k2)).toBeUndefined();
    expect(await keyRecord(c1Id, k3)).toBeUndefined();
  });

  it('SEC-AC08 a body is accepted only as application/json, alone or with charset=utf-8, in any letter case; a request without a body needs no Content-Type', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, c1, 'EUR');
    expect((await deposit(built.app, o1, a1.id, '1000')).statusCode).toBe(201);
    const body = JSON.stringify({ amount: '100', currency: 'EUR' });
    const withdrawWith = async (contentType: string | undefined) =>
      await built.app.inject({
        method: 'POST',
        url: `/v1/accounts/${a1.id}/withdrawals`,
        headers: {
          ...bearer(c1),
          'idempotency-key': randomUUID(),
          ...(contentType === undefined ? {} : { 'content-type': contentType }),
        },
        payload: body,
      });

    for (const contentType of [
      'text/plain',
      'application/x-www-form-urlencoded',
      'application/xml',
      'application/json; charset=latin1',
      undefined,
    ]) {
      const response = await withdrawWith(contentType);
      expect(response.statusCode, String(contentType)).toBe(415);
      expect(problemOf(response).type).toBe('/problems/unsupported-media-type');
    }
    for (const contentType of ['application/json; charset=utf-8', 'Application/JSON']) {
      expect((await withdrawWith(contentType)).statusCode, contentType).toBe(201);
    }

    const freeze = await changeStatus(built.app, o1, a1.id, 'freeze');
    expect(freeze.statusCode).toBe(200);
    expect(await balanceOf(a1.id)).toBe('800');
    expect(freeze.json<{ status: string }>().status).toBe('frozen');
  });

  it('SEC-AC09 the media type and then the size are checked after authentication and the role check, and before the body is parsed', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, c1, 'EUR');
    expect((await deposit(built.app, o1, a1.id, '1000')).statusCode).toBe(201);
    const large = padded(20000);
    const json = { 'content-type': 'application/json' };
    const keyed = { ...bearer(c1), 'idempotency-key': randomUUID() };

    const responses = [
      await built.app.inject({
        method: 'POST',
        url: `/v1/accounts/${a1.id}/withdrawals`,
        headers: { ...json, 'idempotency-key': randomUUID() },
        payload: large,
      }),
      await built.app.inject({
        method: 'POST',
        url: `/v1/accounts/${a1.id}/deposits`,
        headers: { ...json, ...keyed },
        payload: large,
      }),
      await built.app.inject({
        method: 'POST',
        url: `/v1/accounts/${a1.id}/withdrawals`,
        headers: { ...keyed, 'content-type': 'text/plain' },
        payload: 'not json',
      }),
      await built.app.inject({
        method: 'POST',
        url: `/v1/accounts/${a1.id}/withdrawals`,
        headers: { ...keyed, 'content-type': 'text/plain' },
        payload: large,
      }),
      await built.app.inject({
        method: 'POST',
        url: `/v1/accounts/${a1.id}/withdrawals`,
        headers: { ...bearer(c1), ...json },
        payload: large,
      }),
    ];

    expect(responses.map((response) => [response.statusCode, problemOf(response).type])).toEqual([
      [401, '/problems/unauthenticated'],
      [403, '/problems/forbidden'],
      [415, '/problems/unsupported-media-type'],
      [415, '/problems/unsupported-media-type'],
      [413, '/problems/payload-too-large'],
    ]);
    expect(await balanceOf(a1.id)).toBe('1000');
  });

  it('SEC-R11 a request without a body is never refused for its Content-Type', async () => {
    const o1 = tokenFor(randomUUID(), 'operator');
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded']) {
      const a1 = await createAccount(built.app, tokenFor(randomUUID(), 'customer'), 'EUR');
      const freeze = await built.app.inject({
        method: 'POST',
        url: `/v1/accounts/${a1.id}/freeze`,
        headers: { ...bearer(o1), 'content-type': contentType, 'content-length': '0' },
        payload: '',
      });
      expect(freeze.statusCode, contentType).toBe(200);
      expect(freeze.json<{ status: string }>().status, contentType).toBe('frozen');
    }
  });

  it('SEC-R10 SEC-R11 a refused body of about 100 KB is answered with Connection: close and never stalls its connection', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const a1 = await createAccount(built.app, c1, 'EUR');
    for (const [contentType, status] of [
      ['text/plain', '415 Unsupported Media Type'],
      ['application/json', '413 Payload Too Large'],
    ] as const) {
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
      const body = 'x'.repeat(102400);
      socket.write(
        `POST /v1/accounts/${a1.id}/withdrawals HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
          `Authorization: Bearer ${c1}\r\nIdempotency-Key: ${randomUUID()}\r\n` +
          `Content-Type: ${contentType}\r\nContent-Length: ${String(body.length)}\r\n\r\n`,
      );
      socket.write(body);

      const deadline = Date.now() + 5000;
      while (!state.closed && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(state.received.split('\r\n')[0], contentType).toBe(`HTTP/1.1 ${status}`);
      expect(state.received.toLowerCase(), contentType).toContain('connection: close');
      expect(state.closed, contentType).toBe(true);
      socket.destroy();
    }
  });
});
