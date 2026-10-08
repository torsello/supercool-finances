/**
 * The OpenAPI text of the account routes (section 1 of spec 001): what Swagger UI shows beside
 * the schemas. Paths carry the `/v1` prefix in the document (SYS-R43).
 */

import {
  BODY_PROBLEMS,
  EXAMPLE,
  KEY_PROBLEMS,
  type OperationDocs,
} from '../../../../platform/http/api-reference.js';

/** Paging, shared by both lists (section 1.5 of spec 001). */
const PAGING =
  'Newest first by (`createdAt`, `id`), one page as `{"items": [...], "nextCursor": "..."}`; `nextCursor` is absent on the last page. `limit` is an integer from 1 to 100, 20 when absent; any other value answers 422 `/problems/validation-error`. Pass `nextCursor` back as `cursor` for the next page: it is opaque, signed by the service, valid on every replica, and only for the same list and user; an altered or foreign cursor answers 400 `/problems/malformed-request`.';

/** The status lifecycle (section 1.2 of spec 001). */
const LIFECYCLE =
  'Lifecycle: `active` → `frozen` (freeze), `frozen` → `active` (unfreeze), `active` or `frozen` → `closed` (close, only with balance "0"); `closed` is final. Asking for the status the account already has answers 200 with the account unchanged; a change outside the lifecycle answers 409 `/problems/invalid-status-transition`; closing an account whose balance is not "0" answers 409 `/problems/account-balance-not-zero`. Takes no `Idempotency-Key`; one sent is ignored. Operators only; a customer gets 403. A system account, an unknown id or an id that is not a UUID answers 404. The account row lock is waited for at most `ACCOUNT_LOCK_TIMEOUT_MS`, then 503 `/problems/service-unavailable` with `Retry-After: 1`.';

export const ACCOUNT_ROUTE_DOCS = {
  'POST /accounts': {
    operationId: 'createAccount',
    tags: ['accounts'],
    summary: 'Open an account',
    description:
      'A customer opens an account of their own in one currency, `active` with balance "0". `Idempotency-Key` is optional here; with one, a repeat answers the first response. Operators get 403.',
  },
  'GET /accounts': {
    operationId: 'listAccounts',
    tags: ['accounts'],
    summary: 'List own accounts',
    description: `A customer lists their own accounts. Operators look accounts up by id and get 403 here. ${PAGING}`,
  },
  'GET /accounts/{id}': {
    operationId: 'readAccount',
    tags: ['accounts'],
    summary: 'Read an account',
    description:
      "Details and cached balance, a string of decimal digits in minor units. A customer reads their own accounts; an operator reads any customer account and also sees `ownerId`. Another customer's account, a system account, an unknown id and an id that is not a UUID all answer the same 404 `/problems/not-found`.",
  },
  'GET /accounts/{id}/entries': {
    operationId: 'listAccountEntries',
    tags: ['accounts'],
    summary: "List an account's history",
    description: `The account's ledger entries, each with a signed amount in minor units ("5000" adds to the balance, "-1200" subtracts), without counterparty or running balance. A customer lists their own accounts; an operator any customer account. ${PAGING}`,
  },
  'POST /accounts/{id}/freeze': {
    operationId: 'freezeAccount',
    tags: ['account status'],
    summary: 'Freeze an account',
    description: `Blocks deposits, withdrawals and transfers on either side; reversals stay allowed. ${LIFECYCLE}`,
  },
  'POST /accounts/{id}/unfreeze': {
    operationId: 'unfreezeAccount',
    tags: ['account status'],
    summary: 'Unfreeze an account',
    description: `Makes a frozen account active again. ${LIFECYCLE}`,
  },
  'POST /accounts/{id}/close': {
    operationId: 'closeAccount',
    tags: ['account status'],
    summary: 'Close an account',
    description: `Closes an account whose balance is "0"; it stays readable. ${LIFECYCLE}`,
  },
} as const;

const ACCOUNT = {
  id: EXAMPLE.accountId,
  currency: 'EUR',
  status: 'active',
  balance: '1050',
  createdAt: EXAMPLE.createdAt,
  updatedAt: EXAMPLE.updatedAt,
} as const;

const ID_PARAMETER = {
  id: { description: 'The account id, a UUID.', example: EXAMPLE.accountId },
};

const LIST_PARAMETERS = {
  limit: {
    description: 'The page size, an integer from 1 to 100; 20 when absent.',
    example: '20',
  },
  cursor: {
    description:
      'The `nextCursor` of the previous page of the same list, as given; absent for the first page.',
  },
};

const STATUS_BODY = {
  description: 'No body, or an empty JSON object.',
  example: {},
  required: false,
};

const STATUS_PROBLEMS = [
  '/problems/malformed-request',
  '/problems/forbidden',
  '/problems/not-found',
] as const;

/** The examples, parameters and problem types of each account operation, by operation id. */
export const ACCOUNT_OPERATION_DOCS: Readonly<Record<string, OperationDocs>> = {
  createAccount: {
    success: {
      status: 201,
      description: 'The new account, `active` with balance "0"; `Location` is its path.',
      example: { ...ACCOUNT, balance: '0', updatedAt: EXAMPLE.createdAt },
      location: `/v1/accounts/${EXAMPLE.accountId}`,
    },
    requestBody: {
      description: 'The currency of the account, fixed for its life.',
      example: { currency: 'EUR' },
      required: true,
    },
    parameters: {},
    idempotencyKey: 'optional',
    problems: [...BODY_PROBLEMS, ...KEY_PROBLEMS, '/problems/forbidden'],
  },
  listAccounts: {
    success: {
      status: 200,
      description: 'One page of the caller’s accounts, newest first.',
      example: { items: [ACCOUNT], nextCursor: EXAMPLE.cursor },
    },
    parameters: LIST_PARAMETERS,
    idempotencyKey: 'none',
    problems: ['/problems/malformed-request', '/problems/forbidden'],
  },
  readAccount: {
    success: {
      status: 200,
      description:
        'The account with its cached balance in minor units; an operator also sees `ownerId`.',
      example: ACCOUNT,
    },
    parameters: ID_PARAMETER,
    idempotencyKey: 'none',
    problems: ['/problems/not-found'],
  },
  listAccountEntries: {
    success: {
      status: 200,
      description: 'One page of the account’s ledger entries, newest first.',
      example: {
        items: [
          {
            id: EXAMPLE.entryId,
            transactionId: EXAMPLE.transactionId,
            kind: 'withdrawal',
            amount: '-1200',
            currency: 'EUR',
            createdAt: EXAMPLE.updatedAt,
          },
        ],
        nextCursor: EXAMPLE.cursor,
      },
    },
    parameters: { ...ID_PARAMETER, ...LIST_PARAMETERS },
    idempotencyKey: 'none',
    problems: ['/problems/malformed-request', '/problems/not-found'],
  },
  freezeAccount: {
    success: {
      status: 200,
      description: 'The account, now `frozen`, with its `ownerId`.',
      example: { ...ACCOUNT, status: 'frozen', ownerId: EXAMPLE.customerId },
    },
    requestBody: STATUS_BODY,
    parameters: ID_PARAMETER,
    idempotencyKey: 'none',
    problems: [...STATUS_PROBLEMS, '/problems/invalid-status-transition'],
  },
  unfreezeAccount: {
    success: {
      status: 200,
      description: 'The account, now `active`, with its `ownerId`.',
      example: { ...ACCOUNT, ownerId: EXAMPLE.customerId },
    },
    requestBody: STATUS_BODY,
    parameters: ID_PARAMETER,
    idempotencyKey: 'none',
    problems: [...STATUS_PROBLEMS, '/problems/invalid-status-transition'],
  },
  closeAccount: {
    success: {
      status: 200,
      description: 'The account, now `closed`, with its `ownerId`.',
      example: { ...ACCOUNT, status: 'closed', balance: '0', ownerId: EXAMPLE.customerId },
    },
    requestBody: STATUS_BODY,
    parameters: ID_PARAMETER,
    idempotencyKey: 'none',
    problems: [...STATUS_PROBLEMS, '/problems/account-balance-not-zero'],
  },
};
