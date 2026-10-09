import pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  buildEvent,
  EVENT_MEMBERS,
  type ReportedRequest,
} from '../../../src/platform/error-reporting/event.js';
import { base64urlJson, K, referenceToken } from '../../support/tokens.js';
import { TEST_CURSOR_SECRET } from '../../support/app.js';

const ACCOUNT = '0192f0a0-0000-7000-8000-00000000a001';

/** A JWT-shaped token other than the request's own. */
const V2 = `${base64urlJson({ alg: 'HS256', typ: 'JWT' })}.${base64urlJson({ sub: 'v2' })}.c2lnbmF0dXJlLXYy`;

/** A database error as `pg` raises it, with the fields that hold values and SQL. */
function databaseError(message: string): pg.DatabaseError {
  const error = new pg.DatabaseError(message, 0, 'error');
  error.code = '23514';
  error.detail = `Failing row contains (${ACCOUNT}, 4321)`;
  error.hint = 'hint-secret-5531';
  error.where = 'where-secret-6642';
  error.position = '7753';
  Object.assign(error, { query: 'UPDATE accounts SET balance = 4321' });
  return error;
}

describe('the error event', () => {
  it('SEC-AC43 keeps only the allowlist of section 1.10, with the message scrubbed of ids, amounts, tokens, secrets and the request key', () => {
    const v = referenceToken();
    const request: ReportedRequest & Record<string, unknown> = {
      id: 'err-3',
      method: 'POST',
      is404: false,
      routeOptions: { url: '/v1/accounts/:id/withdrawals' },
      url: `/v1/accounts/${ACCOUNT}/withdrawals?note=q-88`,
      ip: '203.0.113.9',
      headers: {
        authorization: `Bearer ${v}`,
        'idempotency-key': 'k-77',
        cookie: 'session=c-99',
      },
      body: { amount: '4321', currency: 'EUR' },
      query: { note: 'q-88' },
    };
    const error = databaseError(
      `account ${ACCOUNT} cannot move 4321 with ${V2}, ${v}, ${K} or k-77`,
    );

    const event = buildEvent(error, request, {
      environment: 'production',
      release: '0.1.0',
      replicaId: 'api-1',
      secrets: [K, TEST_CURSOR_SECRET],
      appRoot: '/app',
      eventId: 'a'.repeat(32),
      timestamp: 1791500000,
    });

    expect(Object.keys(event).sort()).toEqual([...EVENT_MEMBERS].sort());
    expect(event.exception.values).toHaveLength(1);
    const [exception] = event.exception.values;
    expect(exception.type).toBe('DatabaseError');
    expect(exception.value).toBe(
      'account <uuid> cannot move <n> with <token>, [Redacted], [Redacted] or [Redacted]',
    );
    expect(event.tags).toEqual({
      requestId: 'err-3',
      route: '/v1/accounts/:id/withdrawals',
      method: 'POST',
      replicaId: 'api-1',
      sqlstate: '23514',
    });
    expect(event).toMatchObject({
      platform: 'node',
      level: 'error',
      environment: 'production',
      release: '0.1.0',
    });
    expect(exception.stacktrace.frames.length).toBeGreaterThan(0);
    for (const frame of exception.stacktrace.frames) {
      expect(Object.keys(frame).sort()).toEqual(['colno', 'filename', 'function', 'lineno']);
    }
    const serialized = JSON.stringify(event);
    for (const forbidden of [
      ACCOUNT,
      '4321',
      v,
      V2,
      K,
      TEST_CURSOR_SECRET,
      'k-77',
      'q-88',
      'c-99',
      '203.0.113.9',
      'Failing row',
      'hint-secret-5531',
      'where-secret-6642',
      '7753',
      'UPDATE accounts',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('SEC-R53 sends the stack frames oldest first, with paths inside the application relative to it', () => {
    const error = new Error('boom');
    error.stack = [
      'Error: boom 0192f0a0-0000-7000-8000-00000000a001',
      '    at inner (file:///app/dist/modules/x.js:10:5)',
      '    at async outer (/app/dist/app.js:20:7)',
      '    at node:internal/process/task_queues:105:5',
    ].join('\n');

    const event = buildEvent(
      error,
      { id: 'r', method: 'GET', is404: true, routeOptions: {}, headers: {} },
      {
        environment: 'test',
        release: '0.1.0',
        replicaId: 'api-2',
        secrets: [],
        appRoot: '/app',
        eventId: 'b'.repeat(32),
        timestamp: 1,
      },
    );

    expect(event.tags).toEqual({
      requestId: 'r',
      route: 'unmatched',
      method: 'GET',
      replicaId: 'api-2',
    });
    expect(event.exception.values[0].stacktrace.frames).toEqual([
      { function: '?', filename: 'node:internal/process/task_queues', lineno: 105, colno: 5 },
      { function: 'async outer', filename: 'dist/app.js', lineno: 20, colno: 7 },
      { function: 'inner', filename: 'dist/modules/x.js', lineno: 10, colno: 5 },
    ]);
    expect(JSON.stringify(event)).not.toContain('0192f0a0');
  });
});
