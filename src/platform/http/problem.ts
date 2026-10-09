/**
 * The problem type registry (SYS-R24, ADR-0016): every type the service answers, with its status
 * and its fixed `title` and `detail`, so bodies of one type differ only in `requestId` (SYS-R05,
 * MOV-R15). Only a malformed request names what is broken in its `detail` (SYS-R26).
 */

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export interface ProblemType {
  status: number;
  title: string;
  detail: string;
}

export const PROBLEM_TYPES = {
  '/problems/not-found': {
    status: 404,
    title: 'Not Found',
    detail: 'The requested resource does not exist.',
  },
  '/problems/unauthenticated': {
    status: 401,
    title: 'Unauthenticated',
    detail: 'A valid bearer token is required.',
  },
  '/problems/forbidden': {
    status: 403,
    title: 'Forbidden',
    detail: 'Your role is not permitted this operation.',
  },
  '/problems/malformed-request': {
    status: 400,
    title: 'Malformed Request',
    detail: 'The request is malformed.',
  },
  '/problems/unsupported-media-type': {
    status: 415,
    title: 'Unsupported Media Type',
    detail: 'The request body must be application/json, in UTF-8.',
  },
  '/problems/payload-too-large': {
    status: 413,
    title: 'Payload Too Large',
    detail: 'The request body is larger than 16384 bytes.',
  },
  '/problems/validation-error': {
    status: 422,
    title: 'Validation Error',
    detail: 'The request content is not valid; see errors.',
  },
  '/problems/idempotency-key-reused': {
    status: 422,
    title: 'Idempotency Key Reused',
    detail: 'This Idempotency-Key was already used for a different request.',
  },
  '/problems/request-in-progress': {
    status: 409,
    title: 'Request In Progress',
    detail: 'A request with this Idempotency-Key is still in progress; retry with the same key.',
  },
  '/problems/invalid-status-transition': {
    status: 409,
    title: 'Invalid Status Transition',
    detail: 'The account status does not allow this change.',
  },
  '/problems/account-balance-not-zero': {
    status: 409,
    title: 'Account Balance Not Zero',
    detail: 'Only an account with a balance of 0 can be closed.',
  },
  '/problems/already-reversed': {
    status: 409,
    title: 'Already Reversed',
    detail: 'The transaction has already been reversed.',
  },
  '/problems/account-not-active': {
    status: 422,
    title: 'Account Not Active',
    detail: 'The account is frozen or closed.',
  },
  '/problems/currency-mismatch': {
    status: 422,
    title: 'Currency Mismatch',
    detail: "The currency does not match the account's currency.",
  },
  '/problems/insufficient-funds': {
    status: 422,
    title: 'Insufficient Funds',
    detail: 'The account balance does not cover the amount.',
  },
  '/problems/destination-unavailable': {
    status: 422,
    title: 'Destination Unavailable',
    detail: 'The destination account cannot receive this transfer.',
  },
  '/problems/balance-limit-exceeded': {
    status: 422,
    title: 'Balance Limit Exceeded',
    detail: 'The movement would take a balance above its limit.',
  },
  '/problems/transaction-not-reversible': {
    status: 422,
    title: 'Transaction Not Reversible',
    detail: 'A reversal cannot be reversed.',
  },
  '/problems/insufficient-funds-for-reversal': {
    status: 422,
    title: 'Insufficient Funds For Reversal',
    detail: 'An account balance does not cover the reversal.',
  },
  '/problems/rate-limited': {
    status: 429,
    title: 'Rate Limited',
    detail: 'Too many requests; retry after the number of seconds in Retry-After.',
  },
  '/problems/service-unavailable': {
    status: 503,
    title: 'Service Unavailable',
    detail:
      'The service could not complete the request in time; retry later, with the same Idempotency-Key if the request had one.',
  },
  '/problems/internal-error': {
    status: 500,
    title: 'Internal Error',
    detail: 'The service failed to process the request.',
  },
} as const satisfies Readonly<Record<string, ProblemType>>;

export type ProblemTypeUri = keyof typeof PROBLEM_TYPES;
