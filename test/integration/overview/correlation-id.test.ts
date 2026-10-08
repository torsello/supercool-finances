import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { bearer, createAccount, problemOf } from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';

/** A UUIDv7 in canonical lowercase, as SYS-R21 generates. */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('correlation ids (SYS-R21, SYS-R22)', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
  });

  it('SYS-AC18 keeps a valid X-Request-Id, generates one otherwise, logs it on every line and puts it in a problem body', async () => {
    const c1 = randomUUID();
    const token = tokenFor(c1, 'customer');
    const a1 = await createAccount(built.app, token);

    built.logs.clear();
    const kept = await built.app.inject({
      method: 'GET',
      url: `/v1/accounts/${a1.id}`,
      headers: { ...bearer(token), 'x-request-id': 'req-123' },
    });
    expect(kept.statusCode).toBe(200);
    expect(kept.headers['x-request-id']).toBe('req-123');
    const lines = built.logs.lines();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.reqId).toBe('req-123');

    const generated = await built.app.inject({
      method: 'GET',
      url: `/v1/accounts/${a1.id}`,
      headers: bearer(token),
    });
    expect(generated.statusCode).toBe(200);
    expect(generated.headers['x-request-id']).toMatch(UUID_V7);

    const tooLong = 'r'.repeat(129);
    const replaced = await built.app.inject({
      method: 'GET',
      url: `/v1/accounts/${a1.id}`,
      headers: { ...bearer(token), 'x-request-id': tooLong },
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.headers['x-request-id']).toMatch(UUID_V7);
    expect(replaced.headers['x-request-id']).not.toBe(tooLong);
    expect(replaced.headers['x-request-id']).not.toBe(generated.headers['x-request-id']);

    const unknown = await built.app.inject({
      method: 'GET',
      url: `/v1/accounts/${randomUUID()}`,
      headers: { ...bearer(token), 'x-request-id': 'req-456' },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.headers['x-request-id']).toBe('req-456');
    expect(problemOf(unknown).requestId).toBe('req-456');
  });

  it('SYS-R21 keeps exactly the values of 1 to 128 characters from A-Z a-z 0-9 . _ : -', async () => {
    const valid = ['a', 'A.b_c:d-9', 'x'.repeat(128)];
    const invalid = ['', ' ', 'req 1', 'req/1', 'reqé1', 'req"1', 'x'.repeat(129), 'a,b'];
    for (const value of valid) {
      const response = await built.app.inject({
        method: 'GET',
        url: '/health/live',
        headers: { 'x-request-id': value },
      });
      expect(response.headers['x-request-id'], value).toBe(value);
    }
    for (const value of invalid) {
      const response = await built.app.inject({
        method: 'GET',
        url: '/health/live',
        headers: { 'x-request-id': value },
      });
      expect(response.headers['x-request-id'], JSON.stringify(value)).toMatch(UUID_V7);
    }
  });

  it('SYS-R21 answers an unauthenticated request and an unknown path with their X-Request-Id', async () => {
    const unauthenticated = await built.app.inject({
      method: 'GET',
      url: `/v1/accounts/${randomUUID()}`,
      headers: { 'x-request-id': 'req-401' },
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.headers['x-request-id']).toBe('req-401');
    expect(problemOf(unauthenticated).requestId).toBe('req-401');

    const unknownPath = await built.app.inject({
      method: 'GET',
      url: '/no-such-path',
      headers: { 'x-request-id': 'req-404' },
    });
    expect(unknownPath.statusCode).toBe(404);
    expect(unknownPath.headers['x-request-id']).toBe('req-404');
    expect(problemOf(unknownPath).requestId).toBe('req-404');
  });
});
