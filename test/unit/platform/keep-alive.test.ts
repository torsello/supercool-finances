import { afterAll, describe, expect, it } from 'vitest';
import { buildApp, KEEP_ALIVE_TIMEOUT_MS } from '../../../src/app.js';
import { loadConfig } from '../../../src/platform/config/config.js';
import { K } from '../../support/tokens.js';

describe('the keep-alive timeout', () => {
  const app = buildApp(
    loadConfig({
      DATABASE_URL: 'postgres://scf_app:unused@127.0.0.1:1/unused',
      REDIS_URL: 'redis://127.0.0.1:1',
      JWT_SECRET: K,
      JWT_ISSUER: 'scf-test',
      JWT_AUDIENCE: 'scf-api',
      CURSOR_SECRET: 'test-only-cursor-secret-for-unit-and-integration',
      LOG_LEVEL: 'fatal',
    }),
  );

  afterAll(async () => {
    await app.close();
  });

  it('SEC-R34 the server keeps idle connections for 65 s, above the load balancer upstream keep-alive of 60 s', () => {
    expect(KEEP_ALIVE_TIMEOUT_MS).toBe(65_000);
    expect(app.server.keepAliveTimeout).toBe(65_000);
  });
});
