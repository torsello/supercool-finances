/**
 * The OpenAPI text of the movement and reversal routes (section 1 of spec 003, section 1 of spec
 * 004): what Swagger UI shows beside the schemas. Paths carry the `/v1` prefix in the document
 * (SYS-R43).
 */

/** What every movement and reversal shares (specs 003 and 005). */
const KEYED =
  'Requires an `Idempotency-Key` header of 1 to 255 visible ASCII characters, fresh for each new request; a missing or malformed one answers 400 `/problems/malformed-request`. A repeat with the same key and body answers the stored response with `Idempotent-Replayed: true`; the same key with another body answers 422 `/problems/idempotency-key-reused`; while the first request is still running, 409 `/problems/request-in-progress`. Answers 201 with `Location: /v1/transactions/{id}`. A lock or retry that runs out answers 503 `/problems/service-unavailable` with `Retry-After: 1`; retry with the same key.';

/** The account rules of a movement (spec 001 section 1.2, spec 003). */
const ACCOUNT_RULES =
  "The currency must be the account's (422 `/problems/currency-mismatch`); a frozen or closed account answers 422 `/problems/account-not-active`. Another customer's account, a system account, an unknown id and an id that is not a UUID answer 404.";

export const MOVEMENT_ROUTE_DOCS = {
  'POST /accounts/{id}/deposits': {
    operationId: 'deposit',
    tags: ['movements'],
    summary: 'Deposit',
    description: `Operators only: simulates money arriving from a payment rail into any customer account, credited to the account and debited to the currency's settlement account. The response has no balance. ${ACCOUNT_RULES} A balance that would pass the maximum answers 422 \`/problems/balance-limit-exceeded\`. ${KEYED}`,
  },
  'POST /accounts/{id}/withdrawals': {
    operationId: 'withdraw',
    tags: ['movements'],
    summary: 'Withdraw',
    description: `Customers only, from their own accounts: debits the account, never below "0" (422 \`/problems/insufficient-funds\`). The response carries the account's new balance. ${ACCOUNT_RULES} ${KEYED}`,
  },
  'POST /accounts/{id}/transfers': {
    operationId: 'transfer',
    tags: ['movements'],
    summary: 'Transfer',
    description: `Customers only, out of their own accounts, to another active customer account in the same currency; the source never goes below "0" (422 \`/problems/insufficient-funds\`). To one of the caller's own accounts, a frozen or closed destination answers 422 \`/problems/account-not-active\` and another currency 422 \`/problems/currency-mismatch\`. Any other destination that cannot be credited (unknown, a system account, another customer's frozen, closed or other-currency account, or a balance that would pass the maximum) gets one answer: 422 \`/problems/destination-unavailable\`. The response carries the source account's new balance. ${ACCOUNT_RULES} ${KEYED}`,
  },
  'GET /transactions/{id}': {
    operationId: 'readTransaction',
    tags: ['transactions'],
    summary: 'Read a transaction',
    description:
      'An operator sees every entry of any transaction; a customer sees a transaction with an entry on one of their own accounts, and only those entries. Entry amounts are signed minor units. Anything else answers 404 `/problems/not-found`.',
  },
  'POST /transactions/{id}/reversals': {
    operationId: 'reverseTransaction',
    tags: ['transactions'],
    summary: 'Reverse a transaction',
    description: `Operators only: writes a compensating transaction with every entry of the original negated, and a \`reason\` of 3 to 500 characters. A transaction is reversed at most once (409 \`/problems/already-reversed\`); a reversal cannot be reversed (422 \`/problems/transaction-not-reversible\`); a customer balance the reversal would take below "0" answers 422 \`/problems/insufficient-funds-for-reversal\`, and one it would take above the maximum 422 \`/problems/balance-limit-exceeded\`. Allowed on a frozen account; a closed one answers 422 \`/problems/account-not-active\`. An unknown transaction or an id that is not a UUID answers 404. ${KEYED}`,
  },
} as const;
