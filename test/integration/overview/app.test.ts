import { connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { bearer, problemOf, withoutRequestId } from '../../support/http.js';
import { LOG_LEVEL } from '../../support/logs.js';
import { C1, O1, tokenFor } from '../../support/tokens.js';

describe('the app built by the composition root', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
  });

  const NOT_FOUND = {
    type: '/problems/not-found',
    title: 'Not Found',
    status: 404,
    detail: 'The requested resource does not exist.',
  };

  it('SYS-R32 answers an unknown path with the not-found problem body, with and without credentials', async () => {
    const credentials = [
      {},
      bearer(tokenFor(C1, 'customer')),
      bearer(tokenFor(O1, 'operator')),
      { authorization: 'Bearer not.a.token' },
    ];
    for (const url of ['/no-such-path', '/v1/no-such-path', '/v1', '/v1/', '/v2/accounts']) {
      for (const headers of credentials) {
        for (const method of ['GET', 'POST'] as const) {
          const response = await built.app.inject({ method, url, headers });
          expect(response.statusCode, `${method} ${url}`).toBe(404);
          const body = problemOf(response);
          expect(withoutRequestId(body)).toEqual(NOT_FOUND);
          expect(typeof body.requestId).toBe('string');
          expect(response.headers['www-authenticate']).toBeUndefined();
        }
      }
    }
  });

  it('SYS-R32 never reads the credentials of a request to an unknown path, so it writes no authentication log line', async () => {
    built.logs.clear();
    await built.app.inject({
      method: 'GET',
      url: '/v1/no-such-path',
      headers: { authorization: 'Basic x' },
    });
    expect(built.logs.lines().filter((line) => line.msg === 'authentication failed')).toEqual([]);
  });

  it('SYS-R43 serves the health check outside /v1 and nothing at /v1/health/live', async () => {
    const live = await built.app.inject({ method: 'GET', url: '/health/live' });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: 'ok' });

    const prefixed = await built.app.inject({ method: 'GET', url: '/v1/health/live' });
    expect(prefixed.statusCode).toBe(404);
    expect(withoutRequestId(problemOf(prefixed))).toEqual(NOT_FOUND);
  });

  it('SYS-R32 answers an unknown path with the not-found problem before its body is read, and logs no error', async () => {
    const bodies = [
      { 'content-type': 'application/json', payload: '{' },
      { 'content-type': 'application/xml', payload: '<deposit amount="100"/>' },
    ];
    for (const url of ['/no-such-path', '/v1/no-such-path']) {
      for (const { payload, ...headers } of bodies) {
        built.logs.clear();
        const response = await built.app.inject({ method: 'POST', url, headers, payload });
        expect(response.statusCode, `${url} ${headers['content-type']}`).toBe(404);
        expect(withoutRequestId(problemOf(response))).toEqual(NOT_FOUND);
        const errors = built.logs.lines().filter((line) => (line.level ?? 0) >= LOG_LEVEL.error);
        expect(errors, `${url} ${headers['content-type']}`).toEqual([]);
      }
    }
  });

  it('SYS-R24 SYS-R32 answers a path that does not decode with the not-found problem and its request id', async () => {
    for (const url of ['/%zz', '/v1/%E0%A4%A']) {
      built.logs.clear();
      const response = await built.app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(404);
      const body = problemOf(response);
      expect(withoutRequestId(body), url).toEqual(NOT_FOUND);
      expect(body.requestId, url).toMatch(/^req-/);
      expect(response.body, url).not.toContain('%');
      expect(
        built.logs.lines().some((line) => line.reqId === body.requestId),
        url,
      ).toBe(true);
    }
  });

  /** Sends raw bytes to the listening app and reads the whole answer until the server closes. */
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

  it('SYS-R24 answers a request the HTTP parser refuses with problem details, the status Fastify uses and a generated id', async () => {
    const tcp = buildProductionApp();
    await tcp.app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const address = tcp.app.server.address();
      if (address === null || typeof address === 'string') throw new Error('no TCP address');
      const cases: [string, string, number][] = [
        ['an invalid header', 'GET /health/live HTTP/1.1\r\nHost: x\r\nBad Header\r\n\r\n', 400],
        [
          'headers above the maximum size',
          `GET /health/live HTTP/1.1\r\nHost: x\r\nX-Big: ${'a'.repeat(20000)}\r\n\r\n`,
          431,
        ],
      ];
      const ids = new Set<string>();
      for (const [name, request, status] of cases) {
        const answer = await rawRequest(address.port, request);
        const [head = '', body = ''] = answer.split('\r\n\r\n');
        const [statusLine, ...headerLines] = head.split('\r\n');
        expect(statusLine, name).toMatch(new RegExp(`^HTTP/1\\.1 ${String(status)} `));
        const headers = Object.fromEntries(
          headerLines.map((line) => {
            const colon = line.indexOf(':');
            return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
          }),
        );
        expect(headers['content-type'], name).toBe('application/problem+json');
        expect(headers['content-length'], name).toBe(String(Buffer.byteLength(body)));
        const problem = JSON.parse(body) as Record<string, unknown>;
        expect(problem, name).toEqual({
          type: '/problems/malformed-request',
          title: 'Malformed Request',
          status,
          detail: expect.any(String) as unknown,
          requestId: expect.stringMatching(/^req-/) as unknown,
        });
        ids.add(String(problem['requestId']));
      }
      expect(ids.size).toBe(cases.length);
    } finally {
      await tcp.app.close();
    }
  });
});
