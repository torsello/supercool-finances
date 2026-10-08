import { validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ValidationFailed } from '../../../src/platform/http/errors.js';
import { amountSchema } from '../../../src/platform/http/schemas/amount.js';
import { currencySchema } from '../../../src/platform/http/schemas/currency.js';
import { uuidSchema } from '../../../src/platform/http/schemas/ids.js';
import { toValidationFailed } from '../../../src/platform/http/validation.js';

const movement = z.strictObject({ amount: amountSchema, currency: currencySchema });

/**
 * The error Fastify attaches to the request with `attachValidation`: the Zod type provider's
 * entries as `validation`, and the part of the request as `validationContext`.
 */
function attachedError(
  schema: z.ZodType,
  data: unknown,
  httpPart: 'body' | 'querystring',
): { validation: unknown; validationContext: string } {
  const result = validatorCompiler({ schema, method: 'POST', url: '/v1/test', httpPart })(data) as {
    error?: unknown;
  };
  if (result.error === undefined) {
    throw new Error('the data passed validation');
  }
  return { validation: result.error, validationContext: httpPart };
}

function errorsOf(schema: z.ZodType, data: unknown, httpPart: 'body' | 'querystring' = 'body') {
  const failure = toValidationFailed(attachedError(schema, data, httpPart));
  expect(failure).toBeInstanceOf(ValidationFailed);
  return failure.errors;
}

describe('validation errors', () => {
  it('SYS-R27 gives one entry per failing body member, with a JSON Pointer, in schema order', () => {
    expect(errorsOf(movement, { amount: '10.50' })).toEqual([
      { pointer: '/amount', detail: expect.stringMatching(/decimal digits/) as unknown },
      { pointer: '/currency', detail: 'Required.' },
    ]);
  });

  it('SYS-R27 AUT-R09 gives one entry for each unknown member, after the schema members, in body order', () => {
    expect(errorsOf(movement, { amount: '100', currency: 'EUR', fee: '1' })).toEqual([
      { pointer: '/fee', detail: 'Unknown member.' },
    ]);
    expect(
      errorsOf(movement, { zeta: 1, currency: 'GBP', alpha: 2, amount: 'x', ownerId: 'u' }),
    ).toEqual([
      { pointer: '/amount', detail: expect.any(String) as unknown },
      { pointer: '/currency', detail: 'Must be one of USD, MXN, EUR, COP, JPY.' },
      { pointer: '/zeta', detail: 'Unknown member.' },
      { pointer: '/alpha', detail: 'Unknown member.' },
      { pointer: '/ownerId', detail: 'Unknown member.' },
    ]);
  });

  it('SYS-R27 keeps one entry for a member with several issues: the first', () => {
    const schema = z.strictObject({
      code: z.string().min(5, { error: 'Too short.' }).regex(/^a/, { error: 'Must start with a.' }),
    });
    expect(errorsOf(schema, { code: 'b' })).toEqual([{ pointer: '/code', detail: 'Too short.' }]);
  });

  it('SYS-R27 points at the whole body with / when it is not an object', () => {
    for (const body of [[], 'text', 42, null]) {
      expect(errorsOf(movement, body), JSON.stringify(body)).toEqual([
        { pointer: '/', detail: expect.any(String) as unknown },
      ]);
    }
  });

  it('SYS-R27 escapes ~ and / in a pointer, and points into nested members', () => {
    const nested = z.strictObject({ destination: z.strictObject({ id: uuidSchema }) });
    expect(errorsOf(nested, { destination: { id: 'x' }, 'a/b~c': true })).toEqual([
      { pointer: '/destination/id', detail: 'Must be a UUID.' },
      { pointer: '/a~1b~0c', detail: 'Unknown member.' },
    ]);
  });

  it('SYS-R27 AUT-R09 names a query string parameter with parameter instead of pointer', () => {
    const query = z.strictObject({ limit: z.string({ error: 'Must be text.' }).optional() });
    expect(errorsOf(query, { ownerId: 'someone' }, 'querystring')).toEqual([
      { parameter: 'ownerId', detail: 'Unknown parameter.' },
    ]);
    expect(errorsOf(query, { limit: ['1', '2'], b: '1', a: '2' }, 'querystring')).toEqual([
      { parameter: 'limit', detail: 'Must be text.' },
      { parameter: 'b', detail: 'Unknown parameter.' },
      { parameter: 'a', detail: 'Unknown parameter.' },
    ]);
  });

  it('SYS-R27 refuses an attached error that does not come from a Zod schema, as a defect', () => {
    expect(() =>
      toValidationFailed({ validation: [{ message: 'x' }], validationContext: 'body' }),
    ).toThrow();
    expect(() => toValidationFailed({ validation: [], validationContext: 'params' })).toThrow();
  });
});
