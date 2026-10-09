import { hostname } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../../src/app.js';
import { loadConfig, type Environment } from '../../../src/platform/config/config.js';
import { replicaIdOf, writeStartupFailure } from '../../../src/platform/logging/logger.js';
import { LogCapture } from '../../support/logs.js';
import { K } from '../../support/tokens.js';

/** The pool and Redis connect lazily, so these apps never reach either. */
const ENV: Environment = {
  DATABASE_URL: 'postgres://scf_app:unused@127.0.0.1:1/unused',
  REDIS_URL: 'redis://127.0.0.1:1',
  JWT_SECRET: K,
  JWT_ISSUER: 'scf-test',
  JWT_AUDIENCE: 'scf-api',
  CURSOR_SECRET: 'test-only-cursor-secret-for-unit-and-integration',
  LOG_LEVEL: 'info',
};

function appWith(env: Environment, logs: LogCapture) {
  return buildApp(loadConfig({ ...ENV, ...env }), { logStream: logs.stream });
}

describe('the replica id in the logs', () => {
  const named = new LogCapture();
  const unnamed = new LogCapture();
  const apps = [appWith({ REPLICA_ID: 'api-1' }, named), appWith({}, unnamed)];

  afterAll(async () => {
    for (const app of apps) await app.close();
  });

  it('DEP-R14 every log line carries replicaId from REPLICA_ID, or the host name when it is unset', async () => {
    const [withId, withoutId] = apps;
    for (const app of [withId, withoutId]) {
      await app?.inject({ method: 'GET', url: '/health/live', headers: { 'x-request-id': 'r-1' } });
      await app?.inject({
        method: 'GET',
        url: '/no-such-path',
        headers: { 'x-request-id': 'r-2' },
      });
      app?.log.info('a line written outside any request');
    }

    for (const [logs, replicaId] of [
      [named, 'api-1'],
      [unnamed, hostname()],
    ] as const) {
      const lines = logs.lines();
      expect(lines.filter((line) => line.reqId === 'r-1').length).toBeGreaterThan(0);
      expect(lines.filter((line) => line.reqId === 'r-2').length).toBeGreaterThan(0);
      expect(lines.filter((line) => line.reqId === undefined).length).toBeGreaterThan(0);
      for (const line of lines) expect(line['replicaId'], JSON.stringify(line)).toBe(replicaId);
    }
  });

  it('DEP-R14 no response carries the replica id, in a header or in the body', async () => {
    const [app] = apps;
    const responses = await Promise.all(
      [
        { method: 'GET', url: '/health/live' },
        { method: 'GET', url: '/health/ready' },
        { method: 'GET', url: '/no-such-path' },
        { method: 'GET', url: '/v1/accounts' },
        { method: 'POST', url: '/v1/accounts', payload: 'not json' },
      ].map(
        async (request) =>
          await app?.inject({
            ...request,
            method: request.method as 'GET' | 'POST',
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    for (const response of responses) {
      const headers = JSON.stringify(response?.headers ?? {});
      const body = response?.body ?? '';
      expect(response?.statusCode).toBeGreaterThan(0);
      expect(headers).not.toMatch(/replica/i);
      expect(headers).not.toContain('api-1');
      expect(body).not.toMatch(/replica/i);
      expect(body).not.toContain('api-1');
    }
  });

  it('DEP-R14 the line of a failed startup carries the replica id when REPLICA_ID is valid, and the host name otherwise', () => {
    const logs = new LogCapture();

    writeStartupFailure(new Error('boom'), logs.stream, replicaIdOf('api-2'));
    writeStartupFailure(new Error('boom'), logs.stream, replicaIdOf('api 2'));
    writeStartupFailure(new Error('boom'), logs.stream, replicaIdOf(undefined));

    expect(logs.lines().map((line) => line['replicaId'])).toEqual([
      'api-2',
      hostname(),
      hostname(),
    ]);
  });
});
