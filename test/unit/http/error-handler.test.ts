import pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  AccountBalanceNotZero,
  AccountNotActive,
  InvalidStatusTransition,
  NotFound,
} from '../../../src/modules/accounts/index.js';
import { Forbidden, Unauthenticated } from '../../../src/modules/auth/domain/errors.js';
import { decide, IdempotencyKeyReused } from '../../../src/modules/idempotency/index.js';
import {
  AlreadyReversed,
  BalanceLimitExceeded,
  TransactionNotReversible,
  Unbalanced,
} from '../../../src/modules/ledger/index.js';
import {
  CurrencyMismatch,
  DestinationUnavailable,
  InsufficientFunds,
  InsufficientFundsForReversal,
} from '../../../src/modules/movements/index.js';
import {
  AccountLockTimeout,
  IdempotencyWaitTimeout,
  LedgerWriteRejected,
  RetriesExhausted,
  StatementTimeout,
} from '../../../src/platform/db/errors.js';
import { problemResponse, toProblem } from '../../../src/platform/http/error-handler.js';
import {
  MalformedRequest,
  RouteNotFound,
  ValidationFailed,
} from '../../../src/platform/http/errors.js';
import { PROBLEM_CONTENT_TYPE, PROBLEM_TYPES } from '../../../src/platform/http/problem.js';

const pgError = (code: string): pg.DatabaseError => {
  const error = new pg.DatabaseError(`fake ${code} at INSERT INTO ledger_entries`, 0, 'error');
  error.code = code;
  return error;
};

const RETRY_AFTER = { 'retry-after': '1' };

/** Every row of plan 000 section 7, with the business rejections of plans 001 to 004. */
const ROWS: readonly [string, unknown, number, string, Record<string, string>][] = [
  ['route not found', new RouteNotFound(), 404, '/problems/not-found', {}],
  [
    'Unauthenticated',
    new Unauthenticated('expired'),
    401,
    '/problems/unauthenticated',
    { 'www-authenticate': 'Bearer realm="supercool-finances"' },
  ],
  ['Forbidden', new Forbidden(), 403, '/problems/forbidden', {}],
  [
    'MalformedRequest request',
    new MalformedRequest('request'),
    400,
    '/problems/malformed-request',
    {},
  ],
  ['MalformedRequest body', new MalformedRequest('body'), 400, '/problems/malformed-request', {}],
  [
    'MalformedRequest header',
    new MalformedRequest('idempotency-key'),
    400,
    '/problems/malformed-request',
    {},
  ],
  [
    'MalformedRequest cursor',
    new MalformedRequest('cursor'),
    400,
    '/problems/malformed-request',
    {},
  ],
  [
    'ValidationFailed',
    new ValidationFailed([{ pointer: '/amount', detail: 'Must be a string of digits.' }]),
    422,
    '/problems/validation-error',
    {},
  ],
  ['IdempotencyKeyReused', new IdempotencyKeyReused(), 422, '/problems/idempotency-key-reused', {}],
  [
    'IdempotencyWaitTimeout',
    new IdempotencyWaitTimeout(),
    409,
    '/problems/request-in-progress',
    RETRY_AFTER,
  ],
  ['NotFound', new NotFound(), 404, '/problems/not-found', {}],
  [
    'InvalidStatusTransition',
    new InvalidStatusTransition('closed', 'freeze'),
    409,
    '/problems/invalid-status-transition',
    {},
  ],
  [
    'AccountBalanceNotZero',
    new AccountBalanceNotZero('active', 'close'),
    409,
    '/problems/account-balance-not-zero',
    {},
  ],
  ['AccountNotActive', new AccountNotActive(), 422, '/problems/account-not-active', {}],
  ['CurrencyMismatch', new CurrencyMismatch(), 422, '/problems/currency-mismatch', {}],
  ['InsufficientFunds', new InsufficientFunds(), 422, '/problems/insufficient-funds', {}],
  [
    'DestinationUnavailable',
    new DestinationUnavailable(),
    422,
    '/problems/destination-unavailable',
    {},
  ],
  ['BalanceLimitExceeded', new BalanceLimitExceeded(), 422, '/problems/balance-limit-exceeded', {}],
  [
    'TransactionNotReversible',
    new TransactionNotReversible(),
    422,
    '/problems/transaction-not-reversible',
    {},
  ],
  ['AlreadyReversed', new AlreadyReversed(), 409, '/problems/already-reversed', {}],
  [
    'AlreadyReversed from the unique constraint',
    new AlreadyReversed({
      cause: { sqlstate: '23505', constraint: 'transactions_reversed_transaction_id_key' },
    }),
    409,
    '/problems/already-reversed',
    {},
  ],
  [
    'InsufficientFundsForReversal',
    new InsufficientFundsForReversal(),
    422,
    '/problems/insufficient-funds-for-reversal',
    {},
  ],
  [
    'AccountLockTimeout',
    new AccountLockTimeout({ cause: pgError('55P03') }),
    503,
    '/problems/service-unavailable',
    RETRY_AFTER,
  ],
  [
    'RetriesExhausted',
    new RetriesExhausted(3, { cause: pgError('40001') }),
    503,
    '/problems/service-unavailable',
    RETRY_AFTER,
  ],
  [
    'StatementTimeout',
    new StatementTimeout({ cause: pgError('57014') }),
    503,
    '/problems/service-unavailable',
    RETRY_AFTER,
  ],
  [
    'LedgerWriteRejected',
    new LedgerWriteRejected('23514', 'ledger_transaction_balanced', { cause: pgError('23514') }),
    500,
    '/problems/internal-error',
    {},
  ],
  ['a domain build error', new Unbalanced(), 500, '/problems/internal-error', {}],
  ['any other error', new Error('boom at pg pool'), 500, '/problems/internal-error', {}],
  ['a pg error', pgError('23505'), 500, '/problems/internal-error', {}],
  ['a thrown string', 'boom at pg pool', 500, '/problems/internal-error', {}],
];

/** The body a problem response sends, parsed. */
function bodyOf(error: unknown, requestId = 'req-1'): Record<string, unknown> {
  const response = problemResponse(toProblem(error), requestId);
  return JSON.parse(Buffer.from(response.body).toString('utf8')) as Record<string, unknown>;
}

describe('toProblem', () => {
  it.each(ROWS)(
    'SYS-R24 SYS-R25 SYS-R28 SYS-R29 SYS-R34 maps %s to its status, type, headers and fixed title and detail',
    (_name, error, status, type, headers) => {
      const problem = toProblem(error);
      expect(problem).toMatchObject({ status, type, headers });
      expect(Object.keys(problem.headers).sort()).toEqual(Object.keys(headers).sort());
      const registered = PROBLEM_TYPES[problem.type];
      expect(registered.status).toBe(status);
      expect(problem.title).toBe(registered.title);
      if (!(error instanceof MalformedRequest)) expect(problem.detail).toBe(registered.detail);
    },
  );

  it('SYS-R24 sends application/problem+json with type, title, status, detail and requestId in that order', () => {
    const response = problemResponse(toProblem(new Forbidden()), 'req-42');
    expect(response.status).toBe(403);
    expect(response.type).toBe('/problems/forbidden');
    expect(response.headers['content-type']).toBe(PROBLEM_CONTENT_TYPE);
    expect(PROBLEM_CONTENT_TYPE).toBe('application/problem+json');
    const text = Buffer.from(response.body).toString('utf8');
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['type', 'title', 'status', 'detail', 'requestId']);
    expect(body).toMatchObject({ type: '/problems/forbidden', status: 403, requestId: 'req-42' });
  });

  it('SYS-R24 adds the extra headers of the problem to the response', () => {
    const response = problemResponse(toProblem(new IdempotencyWaitTimeout()), 'req-1');
    expect(response.headers).toEqual({
      'content-type': PROBLEM_CONTENT_TYPE,
      'retry-after': '1',
    });
  });

  it('SYS-R25 SYS-R24 never puts the message, stack, SQL or cause of an error in a 500 body', () => {
    const errors = [
      new Error('boom at pg pool'),
      pgError('XX000'),
      new LedgerWriteRejected('23514', 'ledger_transaction_balanced', { cause: pgError('23514') }),
      new TypeError('Cannot read properties of undefined (reading "balance")'),
    ];
    for (const error of errors) {
      const text = JSON.stringify(bodyOf(error));
      expect(text).not.toContain('boom');
      expect(text).not.toContain('INSERT');
      expect(text).not.toContain('ledger_');
      expect(text).not.toContain('23514');
      expect(text).not.toContain('Cannot read');
      expect(text).not.toContain(' at ');
      expect(bodyOf(error)).toEqual({ ...bodyOf(new Error('other')), requestId: 'req-1' });
    }
  });

  it('SYS-R26 names what is broken in the detail of a malformed request: the body, the header or the cursor', () => {
    expect(toProblem(new MalformedRequest('request')).detail).toMatch(/request/);
    expect(toProblem(new MalformedRequest('body')).detail).toMatch(/body/);
    expect(toProblem(new MalformedRequest('idempotency-key')).detail).toMatch(
      /Idempotency-Key header/,
    );
    expect(toProblem(new MalformedRequest('cursor')).detail).toMatch(/cursor/);
  });

  it('SYS-R27 adds the errors member to a validation error, after the standard members', () => {
    const errors = [
      { pointer: '/amount', detail: 'Must be a string of digits.' },
      { parameter: 'ownerId', detail: 'Unknown parameter.' },
    ];
    const body = bodyOf(new ValidationFailed(errors));
    expect(Object.keys(body)).toEqual(['type', 'title', 'status', 'detail', 'requestId', 'errors']);
    expect(body['errors']).toEqual(errors);
  });

  it('SYS-R05 MOV-R15 gives bodies of one type that differ only in requestId', () => {
    expect(bodyOf(new NotFound(), 'a')).toEqual({
      ...bodyOf(new RouteNotFound(), 'b'),
      requestId: 'a',
    });
    expect(bodyOf(new DestinationUnavailable(), 'a')).toEqual({
      ...bodyOf(new DestinationUnavailable(), 'b'),
      requestId: 'a',
    });
    expect(bodyOf(new Unauthenticated('missing'), 'a')).toEqual({
      ...bodyOf(new Unauthenticated('signature'), 'b'),
      requestId: 'a',
    });
  });

  it('AUT-R06 answers every 401 with the title and detail of section 1.5 of spec 006', () => {
    expect(bodyOf(new Unauthenticated('claims'), 'r')).toEqual({
      type: '/problems/unauthenticated',
      title: 'Unauthenticated',
      status: 401,
      detail: 'A valid bearer token is required.',
      requestId: 'r',
    });
  });

  it('IDM-R14 maps every lookup and business rejection to a type that spec 005 stores for replay, and nothing else', () => {
    // The route's 404 is answered before the key step, and status changes take no key (plan 001
    // section 6), so neither ever reaches the stored table.
    const keyed = ROWS.filter(
      ([, error]) =>
        !(error instanceof RouteNotFound) &&
        !(error instanceof InvalidStatusTransition) &&
        !(error instanceof AccountBalanceNotZero),
    );
    for (const [name, , status, type] of keyed) {
      const business =
        status === 404 ||
        (status === 409 && type !== '/problems/request-in-progress') ||
        (status === 422 &&
          type !== '/problems/validation-error' &&
          type !== '/problems/idempotency-key-reused');
      expect(decide({ step: 'operation', status, type }).stored, name).toBe(business);
    }
  });
});
