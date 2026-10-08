import swagger, { type FastifyDynamicSwaggerOptions } from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';
import { PROBLEM_CONTENT_TYPE, PROBLEM_TYPES } from './problem.js';

/** Where Swagger UI is served; the OpenAPI document is at `/docs/json` (SEC-R44). */
export const DOCS_PREFIX = '/docs';

/** Every API route starts with this prefix; the health checks and the docs do not (SYS-R43). */
const API_PREFIX = '/v1/';

/** The table of problem types in the document's description (plan 000 section 7). */
function problemTypesTable(): string {
  const rows = Object.entries(PROBLEM_TYPES).map(
    ([type, { status, title }]) => `| \`${type}\` | ${String(status)} | ${title} |`,
  );
  return ['| Type | Status | Title |', '| --- | --- | --- |', ...rows].join('\n');
}

const DESCRIPTION = [
  'Customer accounts, a double-entry ledger, deposits, withdrawals, transfers and reversals.',
  '',
  'Every endpoint is served under the version prefix `/v1`; the health checks and this documentation are not. Every `/v1` request needs `Authorization: Bearer <JWT>`. Amounts are strings of decimal digits in minor units of the currency, with an ISO 4217 code. Every deposit, withdrawal, transfer and reversal requires an `Idempotency-Key` header.',
  '',
  `Every error answer is \`${PROBLEM_CONTENT_TYPE}\` with one of these types:`,
  '',
  problemTypesTable(),
].join('\n');

/** The OpenAPI document's own members; the paths come from the routes. */
const OPENAPI: NonNullable<FastifyDynamicSwaggerOptions['openapi']> = {
  openapi: '3.1.0',
  info: { title: 'SuperCool Finances balance service', version: '1', description: DESCRIPTION },
  servers: [{ url: '/', description: 'This service; every API path starts with /v1.' }],
  components: {
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
            enum: Object.keys(PROBLEM_TYPES),
          },
          title: { type: 'string' },
          status: { type: 'integer' },
          detail: { type: 'string' },
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
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
  },
  security: [{ bearer: [] }],
};

const PROBLEM_CONTENT = {
  [PROBLEM_CONTENT_TYPE]: { schema: { $ref: '#/components/schemas/ProblemDetails' } },
};

/** The error answers every API route may give, as OpenAPI response ranges. */
const PROBLEM_RESPONSES = {
  '4XX': { description: 'A refused request, as problem details.', content: PROBLEM_CONTENT },
  '5XX': {
    description: 'A transient condition (503) or a defect (500), as problem details.',
    content: PROBLEM_CONTENT,
  },
};

/**
 * Swagger UI at `/docs` and the OpenAPI document at `/docs/json`, outside `/v1` and without
 * credentials (SEC-R44), generated from the routes' Zod schemas (ADR-0004). Registered before the
 * routes, so it sees each of them; only `/v1` routes are listed.
 */
export function registerDocs(app: FastifyInstance): void {
  void app.register(swagger, {
    openapi: OPENAPI,
    transform: (input) => {
      const { schema, url } = jsonSchemaTransform(input);
      if (!url.startsWith(API_PREFIX)) return { schema: { ...schema, hide: true }, url };
      const response = (schema.response ?? {}) as Record<string, unknown>;
      return { schema: { ...schema, response: { ...response, ...PROBLEM_RESPONSES } }, url };
    },
  });
  void app.register(swaggerUi, { routePrefix: DOCS_PREFIX });
}
