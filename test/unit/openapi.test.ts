import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/platform/config/config.js';
import {
  LOAD_BALANCER_PROBLEM_TYPES,
  PROBLEM_REFERENCE,
} from '../../src/platform/http/api-reference.js';
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
      REDIS_URL: 'redis://127.0.0.1:1',
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

  it('SEC-R44 documents every problem type of the registry and of the load balancer with its status, title and detail', async () => {
    for (const [type, problem] of Object.entries(PROBLEM_TYPES)) {
      const reference = PROBLEM_REFERENCE[type as keyof typeof PROBLEM_TYPES];
      expect(reference.statuses, type).toEqual([problem.status]);
      expect(reference.title, type).toBe(problem.title);
      expect(reference.detail, type).toBe(problem.detail);
    }
    // The load balancer's own types read as nginx renders them (section 1.5 of spec 008).
    const template = await readFile('docker/nginx/templates/default.conf.template', 'utf8');
    for (const [type, reference] of Object.entries(LOAD_BALANCER_PROBLEM_TYPES)) {
      for (const status of reference.statuses) {
        expect(template, `${type} ${String(status)}`).toContain(
          `return ${String(status)} '${JSON.stringify({ type, title: reference.title, status, detail: reference.detail }).slice(0, -1)},"requestId":`,
        );
      }
    }
    expect(Object.keys(PROBLEM_REFERENCE).sort()).toEqual(
      [...Object.keys(PROBLEM_TYPES), ...Object.keys(LOAD_BALANCER_PROBLEM_TYPES)].sort(),
    );
    const operations = Object.values(document.paths).flatMap((item) => Object.values(item));
    const documented = new Set(
      operations
        .flatMap((operation) => Object.values(operation.responses))
        .flatMap((response) => Object.values(response.content ?? {}))
        .flatMap((media) => Object.values(media.examples ?? {}))
        .map((example) => (example.value as { type?: string }).type),
    );
    expect([...documented].sort()).toEqual(Object.keys(PROBLEM_REFERENCE).sort());
    // Every operation can be rate limited and can meet the load balancer's gateway errors; every
    // operation with a body can be refused for its media type or its size (spec 007).
    for (const operation of operations) {
      const name = operation.operationId ?? '';
      for (const status of ['429', '502', '503', '504']) {
        expect(operation.responses, `${name} ${status}`).toHaveProperty(status);
      }
      for (const status of ['413', '415']) {
        expect(operation.responses[status] !== undefined, `${name} ${status}`).toBe(
          operation.requestBody !== undefined,
        );
      }
    }
    // The 503 names its causes: the pool wait and the request timeout among them (SEC-R33, SEC-R37).
    const unavailable = PROBLEM_REFERENCE['/problems/service-unavailable'].when;
    expect(unavailable).toContain('DB_POOL_ACQUIRE_TIMEOUT_MS');
    expect(unavailable).toContain('REQUEST_TIMEOUT_MS');
  });
});
