import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';

describe('GET /health/live', () => {
  const app = buildApp();

  afterAll(async () => {
    await app.close();
  });

  it('answers 200 with status ok', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.json<unknown>()).toEqual({ status: 'ok' });
  });
});
