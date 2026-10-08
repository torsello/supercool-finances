import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { problemOf } from '../../support/http.js';
import { buildTestApp } from '../../support/test-app.js';

/** The endpoints of specs 001, 003 and 004, as the OpenAPI document names them. */
const ENDPOINTS = [
  '/v1/accounts',
  '/v1/accounts/{id}',
  '/v1/accounts/{id}/entries',
  '/v1/accounts/{id}/freeze',
  '/v1/accounts/{id}/unfreeze',
  '/v1/accounts/{id}/close',
  '/v1/accounts/{id}/deposits',
  '/v1/accounts/{id}/withdrawals',
  '/v1/accounts/{id}/transfers',
  '/v1/transactions/{id}',
  '/v1/transactions/{id}/reversals',
];

interface OpenApiDocument {
  openapi: string;
  paths: Record<string, unknown>;
}

describe('API documentation (SEC-R44)', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
  });

  it('SEC-AC34 serves Swagger UI and the OpenAPI document outside /v1 without credentials', async () => {
    const ui = await built.app.inject({ method: 'GET', url: '/docs' });
    expect(ui.statusCode).toBe(200);
    expect(ui.headers['content-type']).toMatch(/^text\/html/);

    const json = await built.app.inject({ method: 'GET', url: '/docs/json' });
    expect(json.statusCode).toBe(200);
    const document = json.json<OpenApiDocument>();
    expect(document.openapi).toMatch(/^3\./);
    const paths = Object.keys(document.paths);
    expect(paths).toEqual(expect.arrayContaining(ENDPOINTS));
    for (const path of paths) expect(path).toMatch(/^\/v1\//);

    const prefixed = await built.app.inject({ method: 'GET', url: '/v1/docs' });
    expect(prefixed.statusCode).toBe(404);
    expect(problemOf(prefixed).type).toBe('/problems/not-found');
  });

  it('SEC-R44 SYS-R37 the test app, with its seams, serves the same document without the throwing route', async () => {
    const test = buildTestApp();
    try {
      await test.app.ready();
      const json = await test.app.inject({ method: 'GET', url: '/docs/json' });
      expect(json.statusCode).toBe(200);
      const document = json.json<OpenApiDocument>();
      expect(Object.keys(document.paths)).toEqual(expect.arrayContaining(ENDPOINTS));
      expect(Object.keys(document.paths)).not.toContain('/v1/test/throw');
    } finally {
      await test.app.close();
    }
  });
});
