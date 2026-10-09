import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/platform/config/config.js';
import { K } from '../support/tokens.js';

describe('GET /health/live', () => {
  // The pool connects lazily, so this app never reaches the database.
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

  it('answers 200 with status ok', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.json<unknown>()).toEqual({ status: 'ok' });
  });
});
