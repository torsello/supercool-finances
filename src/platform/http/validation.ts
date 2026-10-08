import {
  hasZodFastifySchemaValidationErrors,
  validatorCompiler,
  type ZodFastifySchemaValidationError,
} from 'fastify-type-provider-zod';
import type { z } from 'zod';
import { ValidationFailed, type ValidationIssue } from './errors.js';

/** The error Fastify attaches to a request when a route registers its schemas with `attachValidation`. */
export interface AttachedValidationError {
  validation?: unknown;
  validationContext?: string;
}

/** A JSON Pointer reference token (RFC 6901): `~` and `/` escaped. */
function escapeToken(token: string): string {
  return token.replaceAll('~', '~0').replaceAll('/', '~1');
}

function unknownKeys(entry: ZodFastifySchemaValidationError): string[] {
  const keys: unknown = (entry.params as { keys?: unknown }).keys;
  return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string') : [];
}

/** The pointer of a member under `base`, the `instancePath` of its parent object. */
function childPointer(base: string, key: string): string {
  return `${base === '/' ? '' : base}/${escapeToken(key)}`;
}

/** The name of a query string parameter from an `instancePath` such as `/limit`. */
function parameterName(pointer: string): string {
  return pointer.slice(1).split('/')[0] ?? '';
}

/**
 * Turns the schema error attached to a request into `ValidationFailed` (SYS-R27): one entry per
 * failing field, the first issue of each; the members the schema defines in schema order, then the
 * members it does not define in body order. A body member is named by a JSON Pointer, `/` for the
 * whole body; a query string parameter by its name. Only body and query string schemas are
 * expected: path ids and headers are checked at their own steps (plan 000 section 5).
 */
export function toValidationFailed(error: AttachedValidationError): ValidationFailed {
  const context = error.validationContext;
  if (
    (context !== 'body' && context !== 'querystring') ||
    !hasZodFastifySchemaValidationErrors(error)
  ) {
    throw new Error('the attached validation error is not from a body or query string schema');
  }
  const issue =
    context === 'body'
      ? (pointer: string, detail: string): ValidationIssue => ({ pointer, detail })
      : (pointer: string, detail: string): ValidationIssue => ({
          parameter: parameterName(pointer),
          detail,
        });
  const unknownDetail = context === 'body' ? 'Unknown member.' : 'Unknown parameter.';

  const defined = new Map<string, ValidationIssue>();
  const undefinedMembers = new Map<string, ValidationIssue>();
  for (const entry of error.validation) {
    if (entry.keyword === 'unrecognized_keys') {
      for (const key of unknownKeys(entry)) {
        const pointer = childPointer(entry.instancePath, key);
        if (!undefinedMembers.has(pointer))
          undefinedMembers.set(pointer, issue(pointer, unknownDetail));
      }
      continue;
    }
    const pointer =
      context === 'body' ? entry.instancePath : `/${parameterName(entry.instancePath)}`;
    if (!defined.has(pointer))
      defined.set(pointer, issue(pointer, entry.message ?? 'Invalid value.'));
  }
  return new ValidationFailed([...defined.values(), ...undefinedMembers.values()]);
}

/** The parts of a request a route registers a Zod schema for, besides the plain-string path. */
type ValidatedPart = 'body' | 'querystring';

/**
 * The `errors` entries of `data` against `schema`, validated exactly as Fastify validates a
 * registered part, through the Zod type provider; with the parsed value when there is none.
 */
function validatePart(
  schema: z.ZodType,
  data: unknown,
  part: ValidatedPart,
): { value: unknown; issues: readonly ValidationIssue[] } {
  const validate = validatorCompiler({ schema, method: '', url: '', httpPart: part });
  const result = validate(data) as { value?: unknown; error?: unknown };
  if (result.error === undefined) return { value: result.value, issues: [] };
  return {
    value: undefined,
    issues: toValidationFailed({ validation: result.error, validationContext: part }).errors,
  };
}

/**
 * Validates a body with `schema` exactly as a route's registered schema would, through the Zod
 * type provider. Returns the parsed body, or throws the `ValidationFailed` of SYS-R27.
 */
export function parseBody<Schema extends z.ZodType>(
  schema: Schema,
  body: unknown,
): z.output<Schema> {
  const { value, issues } = validatePart(schema, body, 'body');
  if (issues.length > 0) throw new ValidationFailed(issues);
  return value as z.output<Schema>;
}

/** What `validateRequest` needs of a request: its parts as received and Fastify's attached error. */
export interface ValidatedRequest {
  body: unknown;
  query: unknown;
  validationError?: AttachedValidationError | undefined;
  routeOptions: { schema?: { body?: unknown; querystring?: unknown } | undefined };
}

/** A route's registered schema for a part; a route that calls `validateRequest` registers both. */
function registered(request: ValidatedRequest, part: ValidatedPart): z.ZodType {
  const schema = request.routeOptions.schema?.[part];
  if (schema === undefined) throw new Error(`the route registers no ${part} schema`);
  return schema as z.ZodType;
}

/**
 * The validation step of a route that registers both a body and a query string schema (SYS-R27).
 * Fastify validates the parts one after the other and attaches only the first failing one, so a
 * body error would hide the query string's. Every part Fastify did not validate, or refused, is
 * validated again through the Zod type provider, and the issues are merged: the body's entries
 * first, then the parameters', since SYS-R27 and plan 000 fix no order between them. A part that
 * fails Fastify's validation is left as received, so it is validated as the client sent it.
 *
 * `body` replaces the registered body schema with one the route builds for the request, from the
 * body as received, for a rule a registered schema cannot express because it depends on the path
 * (MOV-R10); its parsed value is returned. Throws the `ValidationFailed` of all the issues.
 */
export function validateRequest(request: ValidatedRequest): void;
export function validateRequest<Schema extends z.ZodType>(
  request: ValidatedRequest,
  body: { schema: Schema; received: unknown },
): z.output<Schema>;
export function validateRequest(
  request: ValidatedRequest,
  body?: { schema: z.ZodType; received: unknown },
): unknown {
  const attached = request.validationError;
  const context = attached?.validationContext;
  if (attached !== undefined && context !== 'body' && context !== 'querystring') {
    throw toValidationFailed(attached);
  }
  const issues: ValidationIssue[] = [];
  let value: unknown;
  if (body !== undefined) {
    const result = validatePart(body.schema, body.received, 'body');
    value = result.value;
    issues.push(...result.issues);
  } else if (context === 'body') {
    issues.push(...validatePart(registered(request, 'body'), request.body, 'body').issues);
  }
  // Fastify validates the query string after the body, so after a body error it never ran.
  if (context !== undefined) {
    issues.push(
      ...validatePart(registered(request, 'querystring'), request.query, 'querystring').issues,
    );
  }
  if (issues.length > 0) throw new ValidationFailed(issues);
  return value;
}
