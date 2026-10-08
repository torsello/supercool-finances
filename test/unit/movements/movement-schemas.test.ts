import { describe, expect, it } from 'vitest';
import {
  movementBody,
  transferBody,
} from '../../../src/modules/movements/adapters/http/schemas.js';
import { ValidationFailed } from '../../../src/platform/http/errors.js';
import { parseBody } from '../../../src/platform/http/validation.js';

const DEFAULT_MAX = 100000000000n;
const A1 = '0192f0c4-0000-7000-8000-0000000000a1';
const B1 = '0192f0c4-0000-7000-8000-0000000000b1';

/** The `errors` entries a body gets, or `undefined` when it passes. */
function errorsOf(schema: Parameters<typeof parseBody>[0], body: unknown) {
  try {
    parseBody(schema, body);
    return undefined;
  } catch (error) {
    if (!(error instanceof ValidationFailed)) throw error;
    return error.errors;
  }
}

function pointers(schema: Parameters<typeof parseBody>[0], body: unknown) {
  return errorsOf(schema, body)?.map((entry) => ('pointer' in entry ? entry.pointer : entry));
}

describe('the movement body schemas', () => {
  it('MOV-R08 MOV-R09 a deposit or withdrawal body gives amount as bigint and the currency, and one errors entry per failing field', () => {
    const body = movementBody(DEFAULT_MAX);
    expect(parseBody(body, { amount: '1050', currency: 'EUR' })).toEqual({
      amount: 1050n,
      currency: 'EUR',
    });
    for (const amount of ['0', '-100', 'abc', '10.50', '0100', '100000000001', 100, undefined]) {
      expect(pointers(body, { amount, currency: 'EUR' }), String(amount)).toEqual(['/amount']);
    }
    for (const currency of [undefined, 'GBP', 'eur', 978]) {
      expect(pointers(body, { amount: '100', currency }), String(currency)).toEqual(['/currency']);
    }
    expect(pointers(body, { amount: '0', currency: 'GBP' })).toEqual(['/amount', '/currency']);
    expect(pointers(body, { currency: 'GBP', amount: '0' })).toEqual(['/amount', '/currency']);
    expect(pointers(body, { amount: '100', currency: 'EUR', note: 'x' })).toEqual(['/note']);
    expect(pointers(body, null)).toEqual(['/']);
  });

  it('LED-R23 LED-R24 the amount accepts the configured maximum and refuses one more, with one errors entry for /amount whose detail holds no part of the value', () => {
    for (const max of [DEFAULT_MAX, 500n]) {
      const body = movementBody(max);
      const transfer = transferBody(max, A1);
      const above = String(max + 1n);
      expect(parseBody(body, { amount: String(max), currency: 'JPY' })).toMatchObject({
        amount: max,
      });
      expect(
        parseBody(transfer, { destinationAccountId: B1, amount: String(max), currency: 'JPY' }),
      ).toMatchObject({ amount: max });
      const errors = errorsOf(body, { amount: above, currency: 'JPY' });
      expect(errors).toEqual([{ pointer: '/amount', detail: expect.any(String) as string }]);
      expect(JSON.stringify(errors)).not.toContain(above);
      expect(
        pointers(transfer, { destinationAccountId: B1, amount: above, currency: 'JPY' }),
      ).toEqual(['/amount']);
    }
  });

  it('MOV-R10 MOV-R30 a transfer body refuses a destination that is missing, not a string, not a UUID, or the source in any letter case, with one errors entry for it', () => {
    const transfer = transferBody(DEFAULT_MAX, A1);
    expect(
      parseBody(transfer, { destinationAccountId: B1.toUpperCase(), amount: '1', currency: 'EUR' }),
    ).toEqual({ destinationAccountId: B1, amount: 1n, currency: 'EUR' });

    for (const destinationAccountId of [
      undefined,
      7,
      null,
      'not-a-uuid',
      `${B1}0`,
      A1,
      A1.toUpperCase(),
    ]) {
      expect(
        pointers(transfer, { destinationAccountId, amount: '1', currency: 'EUR' }),
        String(destinationAccountId),
      ).toEqual(['/destinationAccountId']);
    }
    // The path id is compared in canonical lowercase too.
    expect(
      pointers(transferBody(DEFAULT_MAX, A1.toUpperCase()), {
        destinationAccountId: A1,
        amount: '1',
        currency: 'EUR',
      }),
    ).toEqual(['/destinationAccountId']);
    // A path id that is not a UUID is answered 404 at the lookup, never here.
    expect(
      pointers(transferBody(DEFAULT_MAX, 'not-a-uuid'), {
        destinationAccountId: B1,
        amount: '1',
        currency: 'EUR',
      }),
    ).toBeUndefined();
    // Every failing field gets its entry, in schema order.
    expect(pointers(transfer, { currency: 'GBP', amount: '0', destinationAccountId: A1 })).toEqual([
      '/destinationAccountId',
      '/amount',
      '/currency',
    ]);
  });
});
