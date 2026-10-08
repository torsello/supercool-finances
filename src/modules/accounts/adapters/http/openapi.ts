/**
 * The OpenAPI text of the account routes (section 1 of spec 001): what Swagger UI shows beside
 * the schemas. Paths carry the `/v1` prefix in the document (SYS-R43).
 */

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
