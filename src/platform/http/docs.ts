import { STATUS_CODES } from 'node:http';
import swagger, { type FastifyDynamicSwaggerOptions } from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';
import {
  PROBLEM_CONTENT_TYPE,
  PROBLEM_REFERENCE,
  RETRY_POLICY,
  SHARED_PROBLEMS,
  idempotencyKeyDescription,
  problemExample,
  type DocumentedProblemType,
  type OperationDocs,
} from './api-reference.js';

/** Where Swagger UI is served; the OpenAPI document is at `/docs/json` (SEC-R44). */
export const DOCS_PREFIX = '/docs';

/** Every API route starts with this prefix; the health checks and the docs do not (SYS-R43). */
const API_PREFIX = '/v1/';

export interface DocsOptions {
  /** What each module says about its operations, by operation id. */
  operations: Readonly<Record<string, OperationDocs>>;
  /** `IDEMPOTENCY_KEY_TTL_SECONDS`, stated in the description of the `Idempotency-Key` header. */
  idempotencyKeyTtlSeconds: number;
}

const ALL_PROBLEM_TYPES = Object.keys(PROBLEM_REFERENCE) as DocumentedProblemType[];

/** The table of every problem type in the document's description. */
function problemTypesTable(): string {
  const rows = ALL_PROBLEM_TYPES.map((type) => {
    const { statuses, title, when, replay } = PROBLEM_REFERENCE[type];
    return `| \`${type}\` | ${statuses.join(', ')} | ${title} | ${when} | ${replay} |`;
  });
  return [
    '| Type | Status | Title | When | Stored for replay |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

function description(ttlSeconds: number): string {
  return [
    'Customer accounts, a double-entry ledger, deposits, withdrawals, transfers and reversals.',
    '',
    '**Versioning.** Every endpoint is served under the version prefix `/v1`; the health checks and this documentation (`/docs`, `/docs/json`) are not.',
    '',
    '**Authentication.** Every `/v1` request needs `Authorization: Bearer <JWT>`, an HS256 token with `sub` (the user id, a UUID) and `role` (`customer` or `operator`). The API issues no tokens. A missing or invalid token answers 401; a role not permitted the operation answers 403.',
    '',
    '**Amounts.** Strings of decimal digits in minor units of the currency, with an ISO 4217 code: "1050" is 10.50 EUR, and JPY has no minor units. Ledger entries carry signed amounts.',
    '',
    `**Idempotency.** Every deposit, withdrawal, transfer and reversal requires an \`Idempotency-Key\` header; account creation takes one optionally. ${idempotencyKeyDescription(ttlSeconds, 'required').replace(/^Required\. /, '')}`,
    '',
    "**Correlation.** Every response carries `X-Request-Id`: the client's value when it is 1 to 128 characters of `A-Z a-z 0-9 . _ : -`, a generated UUIDv7 otherwise.",
    '',
    `**Errors.** Every error answer is \`${PROBLEM_CONTENT_TYPE}\` (RFC 9457) with \`type\`, \`title\`, \`status\`, \`detail\` and \`requestId\`, and \`errors\` for a validation error; \`title\` and \`detail\` are fixed per type, and no body holds a stack trace, SQL or an underlying error's message. Checks run in this order and the first failure answers: route (404), authentication (401), per-user rate limit (429), role (403), media type (415), body size (413), malformed request (400), idempotency (a stored response, 422 or 409), validation (422), lookup (404), business rules (409, 422). A stored answer is replayed with \`Idempotent-Replayed: true\`; one not stored committed nothing, so a retry with the same key runs the request again, except a 503 at the request timeout after the \`COMMIT\` was sent and a gateway error (502, 503 or 504 from the load balancer), whose outcome a retry with the same key reveals: the stored response if the movement committed, a new run otherwise. The types:`,
    '',
    problemTypesTable(),
  ].join('\n');
}

interface Parameter {
  in: string;
  name: string;
  required?: boolean;
  schema?: unknown;
  description?: string;
  example?: string;
}

interface MediaType {
  schema?: unknown;
  example?: unknown;
  examples?: Record<string, { summary: string; value: unknown }>;
}

interface Header {
  description: string;
  schema: { type: 'string' };
  example: string;
}

interface Reference {
  $ref: string;
}

interface Response {
  description: string;
  headers?: Record<string, Header | Reference>;
  content?: Record<string, MediaType>;
}

interface Operation {
  operationId?: string;
  parameters?: (Parameter | Reference)[];
  requestBody?: { required?: boolean; description?: string; content: Record<string, MediaType> };
  responses: Record<string, Response>;
  security?: Record<string, string[]>[];
}

/** The part of the generated document this module completes. */
interface GeneratedDocument {
  paths: Record<string, Record<string, Operation>>;
}

function header(text: string, example: string): Header {
  return { description: text, schema: { type: 'string' }, example };
}

const ref = (kind: 'headers' | 'parameters', name: string): Reference => ({
  $ref: `#/components/${kind}/${name}`,
});

/** The headers and parameters every operation shares, referenced from `components`. */
function sharedComponents(ttlSeconds: number) {
  const keySchema = { type: 'string', minLength: 1, maxLength: 255, pattern: '^[!-~]+$' } as const;
  const keyExample = '5b0d7f1e-6c2a-4e8b-9f3d-2a1c4e6b8d0f';
  return {
    headers: {
      RequestId: header(
        "The correlation id of the request: the client's `X-Request-Id` when valid, a generated UUIDv7 otherwise.",
        '0199c3a2-7b10-7c4e-9a52-3f1e2d4c5b60',
      ),
      RetryAfter: header(
        `Seconds to wait before retrying, sent with ${[...RETRIED].map((type) => `\`${type}\``).join(', ')}. ${RETRY_POLICY}`,
        '1',
      ),
      WwwAuthenticate: header(
        'The bearer challenge, the same for every 401.',
        'Bearer realm="supercool-finances"',
      ),
      IdempotentReplayed: header(
        'Present, with value `true`, only when the response is the stored response of an earlier request with the same `Idempotency-Key`.',
        'true',
      ),
    },
    parameters: {
      IdempotencyKey: {
        in: 'header' as const,
        name: 'Idempotency-Key',
        required: true,
        schema: keySchema,
        description: idempotencyKeyDescription(ttlSeconds, 'required'),
        example: keyExample,
      },
      OptionalIdempotencyKey: {
        in: 'header' as const,
        name: 'Idempotency-Key',
        required: false,
        schema: keySchema,
        description: idempotencyKeyDescription(ttlSeconds, 'optional'),
        example: keyExample,
      },
      RequestId: {
        in: 'header' as const,
        name: 'X-Request-Id',
        required: false,
        schema: { type: 'string' as const, pattern: '^[A-Za-z0-9._:-]{1,128}$' },
        description:
          'An optional correlation id, returned in `X-Request-Id`, written on every log line of the request and in a problem body; any other value is replaced by a generated UUIDv7.',
      },
    },
  };
}

/** The types answered with `Retry-After`, the seconds to wait before sending the request again. */
const RETRIED: ReadonlySet<DocumentedProblemType> = new Set([
  '/problems/request-in-progress',
  '/problems/rate-limited',
  '/problems/service-unavailable',
  '/problems/upstream-unavailable',
]);

/**
 * The statuses of the rejections a keyed operation stores and replays: the lookup (404) and the
 * business rules (409, 422), section 1.3 of spec 005.
 */
const STORED_REJECTION_STATUSES: ReadonlySet<number> = new Set([404, 409, 422]);

/**
 * The problem answers of an operation, one per status, each with an example of every type; on a
 * keyed operation, a stored rejection may be a replay, with `Idempotent-Replayed` (IDM-R07).
 */
function problemResponses(
  types: readonly DocumentedProblemType[],
  keyed: boolean,
): Record<string, Response> {
  const byStatus = new Map<number, DocumentedProblemType[]>();
  for (const type of new Set([...types, ...SHARED_PROBLEMS])) {
    for (const status of PROBLEM_REFERENCE[type].statuses) {
      byStatus.set(status, [...(byStatus.get(status) ?? []), type]);
    }
  }
  const responses: Record<string, Response> = {};
  for (const [status, statusTypes] of byStatus) {
    const headers: Record<string, Reference> = { 'X-Request-Id': ref('headers', 'RequestId') };
    if (statusTypes.some((type) => RETRIED.has(type))) {
      headers['Retry-After'] = ref('headers', 'RetryAfter');
    }
    if (status === 401) headers['WWW-Authenticate'] = ref('headers', 'WwwAuthenticate');
    if (keyed && STORED_REJECTION_STATUSES.has(status)) {
      headers['Idempotent-Replayed'] = ref('headers', 'IdempotentReplayed');
    }
    responses[String(status)] = {
      description: [
        `${STATUS_CODES[status] ?? String(status)}, as problem details.`,
        ...statusTypes.map((type) => `\`${type}\`: ${PROBLEM_REFERENCE[type].when}`),
      ].join(' '),
      headers,
      content: {
        [PROBLEM_CONTENT_TYPE]: {
          schema: { $ref: '#/components/schemas/ProblemDetails' },
          examples: Object.fromEntries(
            statusTypes.map((type) => [
              type.slice('/problems/'.length),
              { summary: PROBLEM_REFERENCE[type].title, value: problemExample(type, status) },
            ]),
          ),
        },
      },
    };
  }
  return responses;
}

/** Completes an operation generated from its route schemas with what its docs say. */
function completed(operation: Operation, docs: OperationDocs): Operation {
  const name = operation.operationId ?? 'operation';
  const parameters: (Parameter | Reference)[] = (operation.parameters ?? []).map((parameter) => {
    if ('$ref' in parameter) return parameter;
    const described = docs.parameters[parameter.name];
    if (described === undefined) throw new Error(`${name}: no description of ${parameter.name}`);
    return { ...parameter, ...described };
  });
  if (docs.idempotencyKey === 'required') parameters.push(ref('parameters', 'IdempotencyKey'));
  if (docs.idempotencyKey === 'optional') {
    parameters.push(ref('parameters', 'OptionalIdempotencyKey'));
  }
  parameters.push(ref('parameters', 'RequestId'));

  let requestBody = operation.requestBody;
  if (requestBody !== undefined) {
    if (docs.requestBody === undefined) throw new Error(`${name}: no description of the body`);
    const { description: text, example, required } = docs.requestBody;
    requestBody = {
      ...requestBody,
      required,
      description: text,
      content: Object.fromEntries(
        Object.entries(requestBody.content).map(([type, media]) => [type, { ...media, example }]),
      ),
    };
  }

  const status = String(docs.success.status);
  const success = operation.responses[status];
  if (success === undefined) throw new Error(`${name}: no ${status} response`);
  const successHeaders: Record<string, Header | Reference> = {
    'X-Request-Id': ref('headers', 'RequestId'),
  };
  if (docs.success.status === 201) {
    successHeaders['Location'] = header(
      'The path of the created resource, under `/v1`.',
      docs.success.location,
    );
  }
  if (docs.idempotencyKey !== 'none') {
    successHeaders['Idempotent-Replayed'] = ref('headers', 'IdempotentReplayed');
  }
  const responses: Record<string, Response> = {
    [status]: {
      description: docs.success.description,
      headers: successHeaders,
      content: Object.fromEntries(
        Object.entries(success.content ?? {}).map(([type, media]) => [
          type,
          { ...media, example: docs.success.example },
        ]),
      ),
    },
    ...problemResponses(docs.problems, docs.idempotencyKey !== 'none'),
  };

  return {
    ...operation,
    parameters,
    ...(requestBody === undefined ? {} : { requestBody }),
    responses: Object.fromEntries(Object.entries(responses).sort(([a], [b]) => a.localeCompare(b))),
    security: [{ bearer: [] }],
  };
}

/** The OpenAPI document's own members; the paths come from the routes. */
function openapi(ttlSeconds: number): NonNullable<FastifyDynamicSwaggerOptions['openapi']> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'SuperCool Finances balance service',
      version: '1',
      description: description(ttlSeconds),
    },
    servers: [{ url: '/', description: 'This service; every API path starts with /v1.' }],
    tags: [
      { name: 'accounts', description: 'Open, list and read accounts and their history.' },
      { name: 'account status', description: 'Freeze, unfreeze and close accounts (operators).' },
      { name: 'movements', description: 'Deposits, withdrawals and transfers.' },
      { name: 'transactions', description: 'Read and reverse transactions.' },
    ],
    components: {
      ...sharedComponents(ttlSeconds),
      schemas: {
        // The problem details body of every error answer (SYS-R24, SYS-R27, ADR-0016).
        ProblemDetails: {
          type: 'object',
          description:
            'An error answer as RFC 9457 problem details, with content type `application/problem+json`. `title` and `detail` are fixed per type, so two answers of one type differ only in `requestId`; only `/problems/malformed-request` names what is broken in its `detail`.',
          required: ['type', 'title', 'status', 'detail', 'requestId'],
          properties: {
            type: {
              type: 'string',
              description:
                'The problem type, one of the types listed in the description of this API.',
              enum: ALL_PROBLEM_TYPES,
            },
            title: { type: 'string', description: 'A fixed summary of the type.' },
            status: { type: 'integer', description: 'The HTTP status of the answer.' },
            detail: { type: 'string', description: 'A fixed explanation of the type.' },
            requestId: {
              type: 'string',
              description:
                'The correlation id of the request, also sent as `X-Request-Id`; a replay keeps the original one.',
            },
            errors: {
              type: 'array',
              description:
                'Only on `/problems/validation-error`: one entry per failing field, the body member as a JSON Pointer or the query string parameter by name.',
              items: {
                type: 'object',
                required: ['detail'],
                properties: {
                  pointer: { type: 'string' },
                  parameter: { type: 'string' },
                  detail: { type: 'string' },
                },
              },
            },
          },
        },
      },
      securitySchemes: {
        bearer: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'An HS256 JWT with `sub` (the user id, a UUID), `role` (`customer` or `operator`), `iat`, `exp`, `iss` and `aud`. Locally, `npm run token -- --sub <uuid> --role customer` prints one.',
        },
      },
    },
    security: [{ bearer: [] }],
  };
}

/**
 * Swagger UI at `/docs` and the OpenAPI document at `/docs/json`, outside `/v1` and without
 * credentials (SEC-R44), generated from the routes' Zod schemas (ADR-0004) and completed with
 * what each module says about its operations: descriptions, examples, headers and every problem
 * type. Registered before the routes, so it sees each of them; only `/v1` routes are listed, and
 * an operation without docs fails the app when it gets ready.
 */
export function registerDocs(app: FastifyInstance, options: DocsOptions): void {
  const ttlSeconds = options.idempotencyKeyTtlSeconds;
  void app.register(swagger, {
    openapi: openapi(ttlSeconds),
    transform: (input) => {
      const { schema, url } = jsonSchemaTransform(input);
      return url.startsWith(API_PREFIX)
        ? { schema, url }
        : { schema: { ...schema, hide: true }, url };
    },
    transformObject: (documentObject) => {
      // The document is generated in OpenAPI mode, never as Swagger 2.
      if (!('openapiObject' in documentObject)) throw new Error('expected an OpenAPI document');
      const { openapiObject } = documentObject;
      const generated = openapiObject as unknown as GeneratedDocument;
      const paths = Object.fromEntries(
        Object.entries(generated.paths).map(([path, item]) => [
          path,
          Object.fromEntries(
            Object.entries(item).map(([method, operation]) => {
              const docs = options.operations[operation.operationId ?? ''];
              if (docs === undefined) {
                throw new Error(`no OpenAPI docs for ${method.toUpperCase()} ${path}`);
              }
              return [method, completed(operation, docs)];
            }),
          ),
        ]),
      );
      return { ...openapiObject, paths };
    },
  });
  void app.register(swaggerUi, { routePrefix: DOCS_PREFIX });
  // Builds the document once every route is registered, so an undocumented `/v1` route fails
  // the app at startup instead of answering 500 on `/docs/json`. Added once the swagger plugin
  // has loaded, so this hook runs after the plugin's own `onReady` hook, which `swagger()` needs.
  void app.after(() => {
    app.addHook('onReady', (done) => {
      try {
        app.swagger();
        done();
      } catch (error) {
        done(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}
