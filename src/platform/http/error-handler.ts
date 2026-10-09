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
  ConnectionLost,
  IdempotencyWaitTimeout,
  LedgerWriteRejected,
  PoolAcquireTimeout,
  ProxyBorrowTimeout,
  PoolClosed,
  RetriesExhausted,
  StatementTimeout,
} from '../db/errors.js';
import { sqlstateOf } from '../db/sqlstate.js';
// Declares `errorReporter` on the Fastify instance, which `logFailure` calls.
import '../error-reporting/reporter.js';
import {
  MalformedRequest,
  NotReady,
  PayloadTooLarge,
  RateLimited,
  RouteNotFound,
  ShuttingDown,
  UnsupportedMediaType,
  ValidationFailed,
  type MalformedPart,
  type ValidationIssue,
} from './errors.js';
import { PROBLEM_CONTENT_TYPE, PROBLEM_TYPES, type ProblemTypeUri } from './problem.js';
import { RequestTimeout } from './request-timeout.js';

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
const CONNECTION_CLOSE = { connection: 'close' };

const MALFORMED_DETAILS: Readonly<Record<MalformedPart, string>> = {
  request: 'The request could not be parsed.',
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

/**
 * The errors of Fastify's JSON body parser for a body that is not parseable JSON: invalid or
 * poisoned JSON, an empty body, or fewer or more bytes than `Content-Length` says (SYS-R26).
 */
const BODY_PARSE_ERRORS: ReadonlySet<string> = new Set([
  'FST_ERR_CTP_INVALID_JSON_BODY',
  'FST_ERR_CTP_EMPTY_JSON_BODY',
  'FST_ERR_CTP_INVALID_CONTENT_LENGTH',
]);

/** The code of a Fastify error, such as `FST_ERR_CTP_BODY_TOO_LARGE`, if it has one. */
function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function isBodyParseError(error: unknown): boolean {
  const code = codeOf(error);
  return code !== undefined && BODY_PARSE_ERRORS.has(code);
}

/**
 * A body above `bodyLimit`, which Fastify refuses by `Content-Length` before reading it or once
 * the bytes received pass it (SEC-R10).
 */
function isPayloadTooLarge(error: unknown): boolean {
  return error instanceof PayloadTooLarge || codeOf(error) === 'FST_ERR_CTP_BODY_TOO_LARGE';
}

/**
 * A body no content-type parser accepts (SEC-R11). The media-type hook of `body-limits.ts` refuses
 * it first; Fastify's own error is mapped the same way as a fallback.
 */
function isUnsupportedMediaType(error: unknown): boolean {
  return (
    error instanceof UnsupportedMediaType || codeOf(error) === 'FST_ERR_CTP_INVALID_MEDIA_TYPE'
  );
}

/**
 * A Fastify error with status exactly 400 that no mapping above recognises, such as the request
 * stream failing when a client aborts mid-body: a request that could not be read, answered as a
 * malformed body and not logged as a failure (SYS-R25, SYS-R26). 413, 415 and every other status
 * are left to their own mappings.
 */
function isUnrecognisedClientError(error: unknown): boolean {
  return error instanceof Error && 'statusCode' in error && error.statusCode === 400;
}

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
  if (error instanceof RateLimited) {
    return problemOf('/problems/rate-limited', {
      'retry-after': String(error.retryAfterSeconds),
    });
  }
  // The refused body is not read: closing the connection discards it, so it never stalls.
  if (isUnsupportedMediaType(error)) {
    return problemOf('/problems/unsupported-media-type', CONNECTION_CLOSE);
  }
  if (isPayloadTooLarge(error)) return problemOf('/problems/payload-too-large', CONNECTION_CLOSE);
  if (error instanceof MalformedRequest) {
    return { ...problemOf('/problems/malformed-request'), detail: MALFORMED_DETAILS[error.part] };
  }
  if (isBodyParseError(error)) {
    return { ...problemOf('/problems/malformed-request'), detail: MALFORMED_DETAILS.body };
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
    error instanceof StatementTimeout ||
    error instanceof PoolAcquireTimeout ||
    error instanceof ProxyBorrowTimeout ||
    error instanceof ConnectionLost ||
    error instanceof PoolClosed ||
    error instanceof ShuttingDown ||
    error instanceof RequestTimeout
  ) {
    return problemOf('/problems/service-unavailable', RETRY_AFTER);
  }
  // The same body whatever check failed, without Retry-After: the orchestrator polls (SEC-R24).
  if (error instanceof NotReady) return problemOf('/problems/service-unavailable');
  const rejection = REJECTIONS.find(([type]) => error instanceof type);
  if (rejection !== undefined) return problemOf(rejection[1]);
  if (isUnrecognisedClientError(error)) {
    return { ...problemOf('/problems/malformed-request'), detail: MALFORMED_DETAILS.body };
  }
  return problemOf('/problems/internal-error');
}

/** A change to a new response body before it is serialized: the hook point of a test seam. */
export type BodyExtension = (body: Record<string, unknown>) => Record<string, unknown>;

/**
 * The response of a problem for one request: `application/problem+json` with `type`, `title`,
 * `status`, `detail`, `requestId` and, for validation, `errors` (SYS-R22, SYS-R24, SYS-R27).
 * `extend` is set only by the keyed handler, for the `extra-response-member` test seam (plan 000
 * section 8).
 */
export function problemResponse(
  problem: Problem,
  requestId: string,
  extend?: BodyExtension,
): ProblemHttpResponse {
  const body: Record<string, unknown> = {
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
    body: Buffer.from(JSON.stringify(extend === undefined ? body : extend(body)), 'utf8'),
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
 * Fastify's error handler: answers every error with its problem, and logs a 500 (`logFailure`).
 * Other answers are not logged here: authentication logs its own `warn` line with the reason
 * (AUT-R19).
 */
export async function handleError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const problem = toProblem(error);
  logFailure(request, error, problem);
  return await sendProblem(reply, problemResponse(problem, request.id));
}

/**
 * Logs an error answered as a 500 at `error`, with the error, which stays in the log only, and
 * the SQLSTATE of a database error, so the request whose connection was lost names it with its
 * `reqId` (SYS-R22); a `LedgerWriteRejected` also names its constraint (LED-R28). A transient 503
 * is logged at `warn` with its cause and SQLSTATE, so a statement timeout (57014) is told apart
 * from the request timeout or an exhausted pool (SEC-R32, SEC-R33, SEC-R37). Every other answer
 * is not logged here. A 500 is also handed to the error reporter, when there is one (section 1.10
 * of spec 007).
 */
export function logFailure(request: FastifyRequest, error: unknown, problem: Problem): void {
  if (problem.type === '/problems/service-unavailable') {
    const sqlstate = sqlstateOf(error);
    request.log.warn(
      {
        cause: error instanceof Error ? error.name : typeof error,
        ...(sqlstate === undefined ? {} : { sqlstate }),
      },
      'service unavailable',
    );
    return;
  }
  if (problem.status >= 500 && problem.type === '/problems/internal-error') {
    const sqlstate = sqlstateOf(error);
    const fields =
      error instanceof LedgerWriteRejected
        ? { err: error, sqlstate: error.sqlstate, constraint: error.constraint }
        : { err: error, ...(sqlstate === undefined ? {} : { sqlstate }) };
    request.log.error(fields, 'request failed');
    // The one place every 500 passes, so each is reported exactly once (SEC-R50, SEC-R52).
    request.server.errorReporter?.report(error, request);
  }
}
