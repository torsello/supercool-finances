import {
  hasZodFastifySchemaValidationErrors,
  type ZodFastifySchemaValidationError,
} from 'fastify-type-provider-zod';
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
