import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/platform/config/config.js';
import { PROBLEM_REFERENCE } from '../../src/platform/http/api-reference.js';
import { PROBLEM_TYPES } from '../../src/platform/http/problem.js';
import { OPENAPI_PATH, renderOpenApiYaml } from '../../scripts/openapi.js';
import { K } from '../support/tokens.js';

interface MediaType {
  example?: unknown;
  examples?: Record<string, { value: unknown }>;
}

interface Operation {
  operationId?: string;
  description?: string;
  parameters?: ({ $ref: string } | { name: string; description?: string; example?: unknown })[];
  requestBody?: { description?: string; content: Record<string, MediaType> };
  responses: Record<string, { description?: string; content?: Record<string, MediaType> }>;
  security?: unknown;
}

interface Document {
  paths: Record<string, Record<string, Operation>>;
  components: {
    securitySchemes?: Record<string, unknown>;
    parameters?: Record<string, { name: string; description?: string; example?: unknown }>;
  };
}

describe('the OpenAPI document (SEC-R44)', () => {
  // The pool connects lazily, so this app never reaches the database.
  const app = buildApp(
    loadConfig({
      DATABASE_URL: 'postgres://scf_app:unused@127.0.0.1:1/unused',
      JWT_SECRET: K,
      JWT_ISSUER: 'scf-test',
      JWT_AUDIENCE: 'scf-api',
      CURSOR_SECRET: 'test-only-cursor-secret-for-unit-and-integration',
      LOG_LEVEL: 'fatal',
    }),
  );
  let document: Document;

  beforeAll(async () => {
    await app.ready();
    document = app.swagger() as unknown as Document;
  });

  afterAll(async () => {
    await app.close();
  });

  it(`SEC-R44 ${OPENAPI_PATH} is the document the routes generate; run npm run openapi:export after changing them`, async () => {
    expect(await readFile(OPENAPI_PATH, 'utf8')).toBe(await renderOpenApiYaml());
  });

  it('SEC-R44 gives every request and response a description and an example, with the bearer scheme', () => {
    expect(document.components.securitySchemes).toHaveProperty('bearer');
    const operations = Object.entries(document.paths).flatMap(([path, item]) =>
      Object.entries(item).map(([method, operation]) => [`${method} ${path}`, operation] as const),
    );
    expect(operations.length).toBe(12);
    for (const [name, operation] of operations) {
      expect(operation.description, name).toEqual(expect.any(String));
      expect(operation.security, name).toEqual([{ bearer: [] }]);
      for (const listed of operation.parameters ?? []) {
        const parameter =
          '$ref' in listed
            ? document.components.parameters?.[listed.$ref.split('/').pop() ?? '']
            : listed;
        if (parameter === undefined) throw new Error(`${name}: unresolved parameter`);
        expect(parameter.description, `${name} ${parameter.name}`).toEqual(expect.any(String));
        // Swagger UI's "Try it out" sends a parameter's example as its value, so these two have
        // none: an example cursor answers 400, and an example X-Request-Id would be sent as the
        // correlation id of every call.
        if (parameter.name === 'cursor' || parameter.name === 'X-Request-Id') {
          expect(parameter.example, `${name} ${parameter.name}`).toBeUndefined();
        } else {
          expect(parameter.example, `${name} ${parameter.name}`).toBeDefined();
        }
      }
      if (operation.requestBody !== undefined) {
        expect(operation.requestBody.description, name).toEqual(expect.any(String));
        for (const media of Object.values(operation.requestBody.content)) {
          expect(media.example, name).toBeDefined();
        }
      }
      for (const [status, response] of Object.entries(operation.responses)) {
        expect(response.description, `${name} ${status}`).toEqual(expect.any(String));
        const media = Object.values(response.content ?? {});
        expect(media.length, `${name} ${status}`).toBeGreaterThan(0);
        for (const content of media) {
          const examples = content.example ?? content.examples;
          expect(examples, `${name} ${status}`).toBeDefined();
        }
      }
      for (const status of ['401', '500', '503']) {
        expect(operation.responses, name).toHaveProperty(status);
      }
    }
  });

  it('SEC-R44 documents every problem type of the registry with its status, title and detail', () => {
    for (const [type, problem] of Object.entries(PROBLEM_TYPES)) {
      const reference = PROBLEM_REFERENCE[type as keyof typeof PROBLEM_TYPES];
      expect(reference.statuses, type).toContain(problem.status);
      expect(reference.title, type).toBe(problem.title);
      expect(reference.detail, type).toBe(problem.detail);
    }
    const documented = new Set(
      Object.values(document.paths)
        .flatMap((item) => Object.values(item))
        .flatMap((operation) => Object.values(operation.responses))
        .flatMap((response) => Object.values(response.content ?? {}))
        .flatMap((media) => Object.values(media.examples ?? {}))
        .map((example) => (example.value as { type?: string }).type),
    );
    expect([...documented].sort()).toEqual(Object.keys(PROBLEM_REFERENCE).sort());
    // Only what the service answers today: the 413, 415 and 429 types of spec 007 and the load
    // balancer's upstream-unavailable join with the 12-infra docs task of plan 007, as do the pool
    // wait and the request timeout among the causes of a 503.
    const text = JSON.stringify(document);
    for (const type of [
      '/problems/payload-too-large',
      '/problems/unsupported-media-type',
      '/problems/rate-limited',
      '/problems/upstream-unavailable',
    ]) {
      expect(text, type).not.toContain(type);
    }
    for (const status of ['413', '415', '429', '502', '504']) {
      for (const item of Object.values(document.paths)) {
        for (const operation of Object.values(item)) {
          expect(operation.responses, status).not.toHaveProperty(status);
        }
      }
    }
    expect(text).not.toContain('no database connection free');
    expect(text).not.toContain('request timeout');
  });
});
