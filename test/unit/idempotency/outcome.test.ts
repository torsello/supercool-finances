import { describe, expect, it } from 'vitest';
import { decide, isStored, type Outcome } from '../../../src/modules/idempotency/index.js';

const BUSINESS_REJECTIONS: [number, string][] = [
  [409, '/problems/already-reversed'],
  [422, '/problems/currency-mismatch'],
  [422, '/problems/account-not-active'],
  [422, '/problems/insufficient-funds'],
  [422, '/problems/destination-unavailable'],
  [422, '/problems/balance-limit-exceeded'],
  [422, '/problems/transaction-not-reversible'],
  [422, '/problems/insufficient-funds-for-reversal'],
];

describe('what is stored (section 1.3 of spec 005)', () => {
  it('IDM-R15 a 201 decided after the business rules is stored and commits with the effects', () => {
    const outcome: Outcome = { step: 'operation', status: 201 };
    expect(decide(outcome)).toEqual({ stored: true, ending: 'commit' });
    expect(isStored(outcome)).toBe(true);
  });

  it('IDM-R14 a 404 at the lookup and every business rejection are stored after a rollback to the savepoint', () => {
    for (const [status, type] of [[404, '/problems/not-found'], ...BUSINESS_REJECTIONS] as const) {
      const outcome: Outcome = { step: 'operation', status, type };
      expect(decide(outcome), type).toEqual({ stored: true, ending: 'rollback-to-savepoint' });
      expect(isStored(outcome)).toBe(true);
    }
  });

  it('IDM-R16 a validation error is not stored and rolls back entirely', () => {
    const outcome: Outcome = { step: 'operation', status: 422, type: '/problems/validation-error' };
    expect(decide(outcome)).toEqual({ stored: false, ending: 'rollback' });
    expect(isStored(outcome)).toBe(false);
  });

  it('IDM-R09 IDM-R12 the answers of the key step are not stored and roll back entirely', () => {
    for (const [status, type] of [
      [422, '/problems/idempotency-key-reused'],
      [409, '/problems/request-in-progress'],
    ] as const) {
      const outcome: Outcome = { step: 'key-step', status, type };
      expect(decide(outcome), type).toEqual({ stored: false, ending: 'rollback' });
    }
  });

  it('IDM-R17 a 503 or a 500 after the key insert is not stored and rolls back entirely', () => {
    for (const [status, type] of [
      [503, '/problems/service-unavailable'],
      [500, '/problems/internal-error'],
    ] as const) {
      const outcome: Outcome = { step: 'operation', status, type };
      expect(decide(outcome), type).toEqual({ stored: false, ending: 'rollback' });
    }
  });

  it('IDM-R17 a 503 for the request timeout after COMMIT was sent is not stored itself, and the commit finishes with the response stored before it', () => {
    const outcome: Outcome = {
      step: 'commit-sent',
      status: 503,
      type: '/problems/service-unavailable',
    };
    expect(decide(outcome)).toEqual({ stored: false, ending: 'commit' });
  });

  it('IDM-R08 the answers before the key step open no database transaction and are not stored, a 404 for an unknown route included', () => {
    for (const [status, type] of [
      [400, '/problems/malformed-request'],
      [401, '/problems/unauthenticated'],
      [403, '/problems/forbidden'],
      [404, '/problems/not-found'],
      [413, '/problems/payload-too-large'],
      [415, '/problems/unsupported-media-type'],
      [429, '/problems/rate-limited'],
    ] as const) {
      const outcome: Outcome = { step: 'before-key-step', status, type };
      expect(decide(outcome), type).toEqual({ stored: false, ending: 'no-transaction' });
    }
  });

  it('IDM-R14 IDM-R17 stores a rejection only with the status of its type, and nothing of an unknown type', () => {
    for (const outcome of [
      { step: 'operation', status: 422, type: '/problems/not-found' },
      { step: 'operation', status: 409, type: '/problems/insufficient-funds' },
      { step: 'operation', status: 422, type: '/problems/something-new' },
      { step: 'operation', status: 404 },
      { step: 'key-step', status: 201 },
    ] satisfies Outcome[]) {
      expect(decide(outcome), JSON.stringify(outcome)).toEqual({
        stored: false,
        ending: 'rollback',
      });
    }
  });
});
