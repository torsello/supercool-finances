import { PROBLEM_CONTENT_TYPE, PROBLEM_TYPES, type ProblemTypeUri } from './problem.js';

/**
 * The reference text of the OpenAPI document that no route schema holds: every problem type the
 * service answers, the `Idempotency-Key` header and the client retry policy (section 1.5 of spec 008). Each
 * module describes its own operations with `OperationDocs`, and `docs.ts` merges both into the
 * document generated from the route schemas.
 */

/**
 * The problem types the document lists: those the service answers today. The types of spec 007
 * (413, 415, 429) and the load balancer's `/problems/upstream-unavailable` (spec 008) join with
 * the 12-infra docs task of plan 007, once 09-hardening and 10-runtime serve them, as do the
 * pool wait and the request timeout among the causes of a 503.
 */
export type DocumentedProblemType = ProblemTypeUri;

interface ProblemReference {
  /** The statuses the type is answered with. */
  statuses: readonly number[];
  title: string;
  detail: string;
  /** When the type is answered, as the error catalogues of the specs say. */
  when: string;
}

/** When each problem type is answered (section 4 of spec 000 and the catalogues of specs 001 to 008). */
const WHEN: Readonly<Record<DocumentedProblemType, string>> = {
  '/problems/malformed-request':
    'The body is not parseable JSON or was cut short, a required header such as `Idempotency-Key` is missing or malformed, or a pagination cursor is invalid. `detail` names what is broken.',
  '/problems/unauthenticated':
    'No `Authorization: Bearer` token, or a token that fails verification: signature, algorithm, issuer, audience, expiry or claims. Every case gets the same body and `WWW-Authenticate` header.',
  '/problems/forbidden':
    'The caller’s role is not permitted the operation, whatever ids the request names.',
  '/problems/not-found':
    'The path is not a route, or the account or transaction does not exist, belongs to another customer, is a system account, or its id is not a UUID. One body for every case.',
  '/problems/request-in-progress':
    'Another request with the same `Idempotency-Key` is still running after `IDEMPOTENCY_WAIT_TIMEOUT_MS`. Retry with the same key after `Retry-After`.',
  '/problems/invalid-status-transition':
    'The status change is not in the lifecycle: freezing or unfreezing a closed account.',
  '/problems/account-balance-not-zero': 'Closing an account whose balance is not "0".',
  '/problems/already-reversed':
    'The transaction has already been reversed; a transaction is reversed at most once.',
  '/problems/validation-error':
    'The request parses, but a body member or query parameter is missing, unknown or malformed, including amount and currency. `errors` has one entry per field.',
  '/problems/idempotency-key-reused':
    'The `Idempotency-Key` was already used by the same user for a request with another method, path or body. Not stored: use a new key for a new request.',
  '/problems/account-not-active':
    "One of the caller's own accounts that the movement debits or credits is frozen or closed (another customer's frozen or closed destination answers `/problems/destination-unavailable`); a reversal is refused only on a closed account.",
  '/problems/currency-mismatch':
    'The request currency differs from the account’s, or a transfer to one of the caller’s own accounts in another currency.',
  '/problems/insufficient-funds': 'The source balance does not cover the amount.',
  '/problems/destination-unavailable':
    'A transfer destination that cannot be credited: unknown, a system account, another customer’s frozen, closed or other-currency account, or a balance that would exceed 9223372036854775807. One answer for every case.',
  '/problems/balance-limit-exceeded':
    'A deposit or reversal would make a cached balance exceed 9223372036854775807.',
  '/problems/transaction-not-reversible': 'The transaction is itself a reversal.',
  '/problems/insufficient-funds-for-reversal':
    'A customer account the reversal debits does not hold enough.',
  '/problems/internal-error': 'A defect. The body never holds internals; report the `requestId`.',
  '/problems/service-unavailable':
    'A transient condition: an account lock not acquired in time, a deadlock still present after 3 attempts, or a statement timeout. Retry after `Retry-After`, with the same `Idempotency-Key` for a POST.',
};

function referenceOf(type: DocumentedProblemType): ProblemReference {
  const { status, title, detail } = PROBLEM_TYPES[type];
  return { statuses: [status], title, detail, when: WHEN[type] };
}

/** Every problem type, in the order of the registry. */
export const PROBLEM_REFERENCE = Object.fromEntries(
  (Object.keys(PROBLEM_TYPES) as DocumentedProblemType[]).map((type) => [type, referenceOf(type)]),
) as Readonly<Record<DocumentedProblemType, ProblemReference>>;

/** The ids and times of the examples of every operation. */
export const EXAMPLE = {
  customerId: '0199c3a0-1e30-7b2a-9c0d-4e5f6a7b8c9d',
  accountId: '0199c3a1-2f40-7a3b-8c1d-5e6f7a8b9c0d',
  otherAccountId: '0199c3a1-3a50-7c4d-8e2f-6a7b8c9d0e1f',
  transactionId: '0199c3a2-0b60-7d5e-9f30-7b8c9d0e1f2a',
  entryId: '0199c3a2-0b61-7e6f-8a41-8c9d0e1f2a3b',
  createdAt: '2026-10-08T14:03:00.123Z',
  updatedAt: '2026-10-08T15:20:41.007Z',
  cursor: 'eyJsIjoiYWNjb3VudHMiLCJ1IjoiMDE5OWMzYTAifQ.5mQfZ3Vb2Xr0Lk8pT1nWcA',
} as const;

/** An example problem body of a type, as the service writes it. */
export function problemExample(type: DocumentedProblemType, status?: number): unknown {
  const reference = PROBLEM_REFERENCE[type];
  return {
    type,
    title: reference.title,
    status: status ?? reference.statuses[0],
    detail: reference.detail,
    requestId: '0199c3a2-7b10-7c4e-9a52-3f1e2d4c5b60',
    ...(type === '/problems/validation-error'
      ? { errors: [{ pointer: '/amount', detail: 'Must be a string of decimal digits.' }] }
      : {}),
  };
}

export { PROBLEM_CONTENT_TYPE };

/** Whether an operation takes an `Idempotency-Key`: required, optional or not at all. */
export type KeyUse = 'required' | 'optional' | 'none';

/** What a module says about one of its operations, beyond its route schemas. */
export interface OperationDocs {
  /**
   * The successful answer: its status, description and an example body, and for a 201 an example
   * of its `Location`.
   */
  success:
    | { status: 200; description: string; example: unknown }
    | { status: 201; description: string; example: unknown; location: string };
  /** The request body's description and example, and whether a body is required. */
  requestBody?: { description: string; example: unknown; required: boolean };
  /** The path and query parameters, by name. */
  parameters: Readonly<Record<string, { description: string; example?: string }>>;
  idempotencyKey: KeyUse;
  /** The problem types the operation itself can answer; the ones every route shares are added. */
  problems: readonly DocumentedProblemType[];
}

/** The problem types every `/v1` operation can answer. */
export const SHARED_PROBLEMS: readonly DocumentedProblemType[] = [
  '/problems/unauthenticated',
  '/problems/validation-error',
  '/problems/internal-error',
  '/problems/service-unavailable',
];

/** The problem types every operation with a JSON body can answer. */
export const BODY_PROBLEMS: readonly DocumentedProblemType[] = ['/problems/malformed-request'];

/** The problem types every operation that takes an `Idempotency-Key` can answer. */
export const KEY_PROBLEMS: readonly DocumentedProblemType[] = [
  '/problems/malformed-request',
  '/problems/request-in-progress',
  '/problems/idempotency-key-reused',
];

/** The client retry policy of section 1.5 of spec 008. */
export const RETRY_POLICY =
  'Retry policy: on a connection error, a 502, 503 or 504, or a 409 `/problems/request-in-progress`, retry the same request with the same `Idempotency-Key`, waiting the `Retry-After` of the response when it has one and 200 ms otherwise, up to 60 times. Never retry any other 4xx. A GET may be re-sent after an error or a timeout.';

/** The `Idempotency-Key` header, for a TTL in seconds (spec 005). */
export function idempotencyKeyDescription(
  ttlSeconds: number,
  use: 'required' | 'optional',
): string {
  const hours = ttlSeconds / 3600;
  const ttl = Number.isInteger(hours)
    ? `${String(hours)} hours (${String(ttlSeconds)} seconds)`
    : `${String(ttlSeconds)} seconds`;
  return [
    use === 'required'
      ? 'Required. A key the client generates for each new request, such as a UUID: 1 to 255 visible ASCII characters (U+0021 to U+007E), sent once.'
      : 'Optional. With one, the account is created at most once for the key; without one, every request creates an account. 1 to 255 visible ASCII characters (U+0021 to U+007E), sent once.',
    'A missing or malformed key answers 400 `/problems/malformed-request`.',
    `Keys are scoped to the authenticated user and kept for ${ttl} from the first request. A repeat with the same key, method, path and body within that time answers the response stored for the first one, status, headers and body, with \`Idempotent-Replayed: true\`; the same key with another method, path or body answers 422 \`/problems/idempotency-key-reused\`; while the first request is still running, 409 \`/problems/request-in-progress\`. After the TTL the key is free and starts a new request.`,
    RETRY_POLICY,
  ].join(' ');
}
