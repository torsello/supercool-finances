import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DEMO_USERS } from '../../../scripts/seed.js';
import { readCompose, readRepositoryFile } from '../../support/deployment.js';

const COLLECTION = 'docs/api/postman/supercool-finances.postman_collection.json';
const ENVIRONMENT = 'docs/api/postman/local.postman_environment.json';

interface PostmanRequest {
  method: string;
  header: { key: string; value: string }[];
  url: { raw: string };
}

interface PostmanItem {
  name: string;
  item?: PostmanItem[];
  request?: PostmanRequest;
  event?: { listen: string; script: { exec: string[] } }[];
}

interface Collection {
  info: { schema: string };
  item: PostmanItem[];
}

/** Every request of the collection, folders flattened, in order. */
function requestsOf(items: readonly PostmanItem[]): PostmanItem[] {
  return items.flatMap((item) => (item.item === undefined ? [item] : requestsOf(item.item)));
}

/**
 * `METHOD /path` of a request, the base URL and the query string removed, and each `{{variable}}`
 * path segment read as a path parameter, as the OpenAPI document writes it: `{id}`.
 */
function operationOf(request: PostmanRequest): string {
  const path = request.url.raw
    .replace(/^\{\{baseUrl\}\}/, '')
    .split('?')[0]
    ?.split('/')
    .map((segment) => (/^\{\{[^}]+\}\}$/.test(segment) ? '{id}' : segment))
    .join('/');
  return `${request.method} ${path ?? ''}`;
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

/** `METHOD /path` of every operation of the OpenAPI document. */
function openApiOperations(): string[] {
  const document = parse(readRepositoryFile('docs/api/openapi.yaml')) as {
    paths: Record<string, Record<string, unknown>>;
  };
  return Object.entries(document.paths).flatMap(([path, operations]) =>
    Object.keys(operations)
      .filter((method) => HTTP_METHODS.has(method))
      .map((method) => `${method.toUpperCase()} ${path}`),
  );
}

describe('the Postman collection', () => {
  it('DEP-AC37 has a request for every operation of the OpenAPI document, tests on every request, and an environment of local values only', () => {
    const collection = JSON.parse(readRepositoryFile(COLLECTION)) as Collection;
    expect(collection.info.schema).toBe(
      'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    );

    const requests = requestsOf(collection.item);
    const covered = new Set(
      requests.flatMap((item) => (item.request === undefined ? [] : [operationOf(item.request)])),
    );
    const operations = openApiOperations();
    expect(operations.length).toBeGreaterThan(0);
    for (const operation of operations) expect(covered, operation).toContain(operation);

    for (const item of requests) {
      const tests = item.event?.find((event) => event.listen === 'test');
      expect(tests?.script.exec.join('\n'), item.name).toContain('pm.test(');
      const request = item.request;
      if (request === undefined) continue;
      if (
        request.method === 'POST' &&
        /\/(deposits|withdrawals|transfers|reversals)$/.test(request.url.raw)
      ) {
        const keys = request.header.filter((header) => header.key === 'Idempotency-Key');
        expect(keys, item.name).toHaveLength(1);
      }
    }

    const environment = JSON.parse(readRepositoryFile(ENVIRONMENT)) as {
      values: { key: string; value: string }[];
    };
    const values = Object.fromEntries(environment.values.map(({ key, value }) => [key, value]));
    const api = readCompose().service('api-1').environment;
    const userId = (name: string) => DEMO_USERS.find((user) => user.name === name)?.id;
    expect(values).toEqual({
      baseUrl: 'http://localhost:8080',
      operatorId: userId('demo-operator'),
      customer1Id: userId('demo-customer-1'),
      customer2Id: userId('demo-customer-2'),
      customer3Id: userId('demo-customer-3'),
      jwtSecret: api['JWT_SECRET'],
      jwtIssuer: api['JWT_ISSUER'],
      jwtAudience: api['JWT_AUDIENCE'],
    });
  });
});
