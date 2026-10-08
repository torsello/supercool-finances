import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  AccountBalanceNotZero,
  AccountNotActive,
  InvalidStatusTransition,
  NotFound,
} from '../../modules/accounts/index.js';
import { Forbidden, Unauthenticated } from '../../modules/auth/index.js';
import { IdempotencyKeyReused } from '../../modules/idempotency/index.js';
import {
  AlreadyReversed,
  BalanceLimitExceeded,
  TransactionNotReversible,
} from '../../modules/ledger/index.js';
import {
  CurrencyMismatch,
  DestinationUnavailable,
  InsufficientFunds,
  InsufficientFundsForReversal,
} from '../../modules/movements/index.js';
import {
  AccountLockTimeout,
  IdempotencyWaitTimeout,
  LedgerWriteRejected,
  RetriesExhausted,
  StatementTimeout,
} from '../db/errors.js';
import {
  MalformedRequest,
  RouteNotFound,
  ValidationFailed,
  type MalformedPart,
  type ValidationIssue,
} from './errors.js';
import { PROBLEM_CONTENT_TYPE, PROBLEM_TYPES, type ProblemTypeUri } from './problem.js';

/** An error as the HTTP edge answers it, before the request's correlation id is added. */
export interface Problem {
  status: number;
  type: ProblemTypeUri;
  title: string;
  detail: string;
  /** Headers besides `content-type`, in lowercase. */
  headers: Readonly<Record<string, string>>;
  errors?: readonly ValidationIssue[];
}

/** A problem as sent: the body as the exact bytes, so the idempotency runner can store them. */
export interface ProblemHttpResponse {
  status: number;
  type: ProblemTypeUri;
  headers: Readonly<Record<string, string>> & { 'content-type': string };
  body: Uint8Array;
}

const UNAUTHENTICATED_HEADERS = { 'www-authenticate': 'Bearer realm="supercool-finances"' };
const RETRY_AFTER = { 'retry-after': '1' };

const MALFORMED_DETAILS: Readonly<Record<MalformedPart, string>> = {
  body: 'The request body is not valid JSON.',
  'idempotency-key': 'The Idempotency-Key header is missing or malformed.',
  cursor: 'The pagination cursor is not valid.',
};

/** The business rejections of plans 001 to 004, each with its own type. */
const REJECTIONS: readonly [new (...args: never[]) => Error, ProblemTypeUri][] = [
  [NotFound, '/problems/not-found'],
  [RouteNotFound, '/problems/not-found'],
  [InvalidStatusTransition, '/problems/invalid-status-transition'],
  [AccountBalanceNotZero, '/problems/account-balance-not-zero'],
  [AlreadyReversed, '/problems/already-reversed'],
  [AccountNotActive, '/problems/account-not-active'],
  [CurrencyMismatch, '/problems/currency-mismatch'],
  [InsufficientFunds, '/problems/insufficient-funds'],
  [DestinationUnavailable, '/problems/destination-unavailable'],
  [BalanceLimitExceeded, '/problems/balance-limit-exceeded'],
  [TransactionNotReversible, '/problems/transaction-not-reversible'],
  [InsufficientFundsForReversal, '/problems/insufficient-funds-for-reversal'],
];

function problemOf(type: ProblemTypeUri, headers: Readonly<Record<string, string>> = {}): Problem {
  const { status, title, detail } = PROBLEM_TYPES[type];
  return { status, type, title, detail, headers };
}

/**
 * The one mapping from errors to status, type and headers (plan 000 section 7). A transient
 * condition is never a 500 (SYS-R34); anything not listed is a 500 whose body holds nothing of the
 * error (SYS-R24, SYS-R25).
 */
export function toProblem(error: unknown): Problem {
  if (error instanceof Unauthenticated) {
    return problemOf('/problems/unauthenticated', UNAUTHENTICATED_HEADERS);
  }
  if (error instanceof Forbidden) return problemOf('/problems/forbidden');
  if (error instanceof MalformedRequest) {
    return { ...problemOf('/problems/malformed-request'), detail: MALFORMED_DETAILS[error.part] };
  }
  if (error instanceof ValidationFailed) {
    return { ...problemOf('/problems/validation-error'), errors: error.errors };
  }
  if (error instanceof IdempotencyKeyReused) return problemOf('/problems/idempotency-key-reused');
  if (error instanceof IdempotencyWaitTimeout) {
    return problemOf('/problems/request-in-progress', RETRY_AFTER);
  }
  if (
    error instanceof AccountLockTimeout ||
    error instanceof RetriesExhausted ||
    error instanceof StatementTimeout
  ) {
    return problemOf('/problems/service-unavailable', RETRY_AFTER);
  }
  const rejection = REJECTIONS.find(([type]) => error instanceof type);
  if (rejection !== undefined) return problemOf(rejection[1]);
  return problemOf('/problems/internal-error');
}

/**
 * The response of a problem for one request: `application/problem+json` with `type`, `title`,
 * `status`, `detail`, `requestId` and, for validation, `errors` (SYS-R22, SYS-R24, SYS-R27).
 */
export function problemResponse(problem: Problem, requestId: string): ProblemHttpResponse {
  const body = {
    type: problem.type,
    title: problem.title,
    status: problem.status,
    detail: problem.detail,
    requestId,
    ...(problem.errors === undefined ? {} : { errors: problem.errors }),
  };
  return {
    status: problem.status,
    type: problem.type,
    headers: { 'content-type': PROBLEM_CONTENT_TYPE, ...problem.headers },
    body: Buffer.from(JSON.stringify(body), 'utf8'),
  };
}

/** Sends a problem response's exact bytes. */
export async function sendProblem(
  reply: FastifyReply,
  response: ProblemHttpResponse,
): Promise<FastifyReply> {
  return await reply.code(response.status).headers(response.headers).send(response.body);
}

/**
 * Fastify's error handler: answers every error with its problem. A 500 is logged at `error` with
 * the error, which stays in the log only; a `LedgerWriteRejected` also names its SQLSTATE and
 * constraint (LED-R28). Other answers are not logged here: authentication logs its own `warn` line
 * with the reason (AUT-R19).
 */
export async function handleError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const problem = toProblem(error);
  if (problem.status >= 500 && problem.type === '/problems/internal-error') {
    const fields =
      error instanceof LedgerWriteRejected
        ? { err: error, sqlstate: error.sqlstate, constraint: error.constraint }
        : { err: error };
    request.log.error(fields, 'request failed');
  }
  return await sendProblem(reply, problemResponse(problem, request.id));
}
