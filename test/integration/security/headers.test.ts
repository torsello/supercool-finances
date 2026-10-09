import { randomUUID } from 'node:crypto';
import { connect, type AddressInfo } from 'node:net';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { SECURITY_HEADERS } from '../../../src/platform/http/security-headers.js';
import { closePools } from '../../support/db.js';
import { bearer, createAccount } from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';

/** The headers of table 1.5 of spec 007, except `Content-Security-Policy` and `Cache-Control`. */
const TABLE_HEADERS = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

/** The policy of every response, and the one of `/docs`, as directive name to its sources. */
const API_POLICY = { 'default-src': ["'none'"], 'frame-ancestors': ["'none'"] };
const DOCS_POLICY = {
  'default-src': ["'self'"],
  'img-src': ["'self'", 'data:'],
  'style-src': ["'self'", "'unsafe-inline'"],
  'frame-ancestors': ["'none'"],
};

/** A `Content-Security-Policy` value as its directives, whatever the separators. */
function directives(value: unknown): Record<string, string[]> {
  if (typeof value !== 'string') throw new Error(`no Content-Security-Policy: ${String(value)}`);
  const entries: [string, string[]][] = [];
  for (const directive of value.split(';')) {
    const [name = '', ...sources] = directive.trim().split(/\s+/);
    if (name !== '') entries.push([name, sources]);
  }
  return Object.fromEntries(entries);
}

describe('security headers', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  function expectTableHeaders(response: LightMyRequestResponse, label: string): void {
    for (const [name, value] of Object.entries(TABLE_HEADERS)) {
      expect(response.headers[name], `${label} ${name}`).toBe(value);
    }
    expect(response.headers, label).not.toHaveProperty('x-powered-by');
  }

  it('SEC-AC11 every response carries the headers of table 1.5, /docs with its own policy, reads under /v1 are not stored, and no response has X-Powered-By', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const a1 = await createAccount(built.app, c1, 'EUR');

    const read = await built.app.inject({
      method: 'GET',
      url: `/v1/accounts/${a1.id}`,
      headers: bearer(c1),
    });
    const missing = await built.app.inject({
      method: 'GET',
      url: `/v1/accounts/${randomUUID()}`,
      headers: bearer(c1),
    });
    const live = await built.app.inject({ method: 'GET', url: '/health/live' });
    const docs = await built.app.inject({ method: 'GET', url: '/docs' });

    expect([read.statusCode, missing.statusCode, live.statusCode, docs.statusCode]).toEqual([
      200, 404, 200, 200,
    ]);
    for (const [label, response] of [
      ['read', read],
      ['404', missing],
      ['health', live],
    ] as const) {
      expectTableHeaders(response, label);
      expect(directives(response.headers['content-security-policy']), label).toEqual(API_POLICY);
    }
    expect(read.headers['cache-control']).toBe('no-store');
    expect(missing.headers['cache-control']).toBe('no-store');

    expectTableHeaders(docs, '/docs');
    expect(directives(docs.headers['content-security-policy'])).toEqual(DOCS_POLICY);
  });

  it('SEC-R14 a read under /v1 reached through a percent-encoded path is still not stored', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const a1 = await createAccount(built.app, c1, 'EUR');
    for (const path of [`/%761/accounts/${a1.id}`, `/v%31/accounts/${a1.id}`]) {
      const response = await built.app.inject({ method: 'GET', url: path, headers: bearer(c1) });
      expect(response.statusCode, path).toBe(200);
      expect(response.json<{ id: string }>().id, path).toBe(a1.id);
      expect(response.headers['cache-control'], path).toBe('no-store');
    }
  });

  it('SEC-R14 the answers given before any hook, to a path that does not decode and to a request the HTTP parser refuses, carry the same headers as helmet sets', async () => {
    // The constant is what helmet sends, plus Cache-Control, which no answer of these may lack.
    const live = await built.app.inject({ method: 'GET', url: '/health/live' });
    const helmetHeaders = Object.fromEntries(
      Object.entries(live.headers).filter(
        ([name]) =>
          ![
            'content-type',
            'content-length',
            'date',
            'connection',
            'keep-alive',
            'x-request-id',
          ].includes(name),
      ),
    );
    const { 'cache-control': cacheControl, ...withoutCache } = SECURITY_HEADERS;
    expect(cacheControl).toBe('no-store');
    expect(helmetHeaders).toEqual(withoutCache);

    const undecodable = await built.app.inject({ method: 'GET', url: '/v1/accounts/%E0%A4%A' });
    expect(undecodable.statusCode).toBe(404);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(undecodable.headers[name], name).toBe(value);
    }

    await built.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = built.app.server.address() as AddressInfo;
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port }, () => {
        socket.write('NOT A REQUEST LINE\r\n\r\n');
      });
      let received = '';
      socket.on('data', (chunk: Buffer) => (received += chunk.toString('latin1')));
      socket.on('close', () => {
        resolve(received);
      });
      socket.on('error', reject);
    });
    const [head = ''] = raw.split('\r\n\r\n');
    const [statusLine, ...headerLines] = head.split('\r\n');
    expect(statusLine).toBe('HTTP/1.1 400 Bad Request');
    const headers = Object.fromEntries(
      headerLines.map((line) => {
        const separator = line.indexOf(':');
        return [line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim()];
      }),
    );
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(headers[name], name).toBe(value);
    }
  });
});
