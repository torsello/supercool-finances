# 004 · Reversals · Plan

How an operator reverses a transaction: the compensating entries, the checks of section 1.4, the unique constraint that keeps a transaction reversed at most once, and how a reversal is read. The shared conventions, the movement skeleton (section 6.2), the transaction runner and the error model are in [plan 000](../000-overview/plan.md); the ledger writes in [plan 002](../002-ledger/plan.md); the lock plan in [plan 003](../003-money-movements/plan.md). The spec wins over this plan.

## 1. Modules and files

Reversals live in the movements module, since a reversal is a money movement (AGENTS.md section 6).

| Path                                                             | Phase     | Purpose                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/modules/ledger/domain/ledger-transaction.ts`                | 06-domain | `reversalOf(original)`: kind `reversal`, the original's currency, `reversedTransactionId`, every entry negated on the same account; refuses a reversal with `TransactionNotReversible` (REV-R01, REV-R07).                                                                                                            |
| `src/modules/movements/domain/reversal-rules.ts`                 | 06-domain | Steps 5 to 8 of section 1.4 as pure functions over the rows read under the locks: existing reversal, `closed` status, funds, balance limit (REV-R06, REV-R08 to REV-R11).                                                                                                                                             |
| `src/modules/movements/domain/errors.ts`                         | 06-domain | Adds `InsufficientFundsForReversal`. `TransactionNotReversible` and `AlreadyReversed` come from the ledger module (plan 002).                                                                                                                                                                                         |
| `src/modules/movements/domain/lock-plan.ts`                      | 06-domain | Reused from plan 003: the plan of a reversal is `planLocks` over the accounts of the original's entries (REV-R18).                                                                                                                                                                                                    |
| `src/modules/movements/application/reverse.ts`                   | 06-domain | The use case, with the optional hook point of the `skip-existing-reversal-check` seam (plan 000 section 8): the hook records that it skipped the check, and the `cause` (`{sqlstate, constraint}`) of the `AlreadyReversed` that `LedgerWriter.append` then threw, so the application layer never reads a `pg` error. |
| `src/modules/movements/adapters/persistence/kysely-movements.ts` | 06-domain | Adds the lookup of the original with its entries, and the check for an existing reversal. The 23505 of the unique constraint is mapped by the ledger adapter, not here (plan 002 section 4).                                                                                                                          |
| `src/modules/movements/adapters/http/schemas.ts`                 | 08-api    | The strict body `{reason}`: a string of 3 to 500 code points counted with the string iterator, no U+0000 to U+001F or U+007F, not only whitespace (REV-R14).                                                                                                                                                          |
| `src/modules/movements/adapters/http/presenters.ts`              | 08-api    | The reversal response of section 1.3, without `reason` or `balance` (REV-R16).                                                                                                                                                                                                                                        |
| `src/modules/movements/adapters/http/routes.ts`                  | 08-api    | `POST /v1/transactions/{id}/reversals`, operator only, through the idempotent runner of plan 005.                                                                                                                                                                                                                     |

## 2. Data model changes

The columns are created by the migration `ledger` of plan 002 (05-schema); this plan owns their rules:

- `transactions.reversed_transaction_id uuid REFERENCES transactions (id)`, with the unique constraint `transactions_reversed_transaction_id_key` (REV-R05). It is not deferrable, so a second reversal fails at its insert, inside the savepoint, where it can still be stored as a 409 (IDM-R14).
- `transactions_reversal_link`: a `reversal` has a link, and no other kind has one.
- `audit_records.reversed_transaction_id` and `audit_records.reason` (plan 000), set only for action `reversal` (REV-R15). The reason is kept exactly as sent in `text`; U+0000 never reaches it, because validation refuses control characters.

## 3. Operation and its database statements

`POST /transactions/{id}/reversals` runs the skeleton of plan 000 section 6.2 with `retry: 'movement'`. Steps 1 to 5 are shared; validation checks `reason` and that the body has no other member and the query string none (REV-R14). Then:

| Step | Statement or check                                                                                                                                                                                                                                                                                                                | Failure (stored)                                       |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 6    | The path id is parsed as a UUID; then `SELECT t.id, t.kind, t.currency, e.id AS entry_id, e.account_id, e.amount, a.kind AS account_kind FROM transactions t JOIN ledger_entries e ON e.transaction_id = t.id JOIN accounts a ON a.id = e.account_id WHERE t.id = $id`, without locks; a transaction and its entries never change | not a UUID or no row: 404                              |
| 6    | `t.kind = 'reversal'`                                                                                                                                                                                                                                                                                                             | 422 `transaction-not-reversible`                       |
| 7    | `SELECT app.set_lock_timeout($accountLockMs)`; then for each id of `planLocks(entries' accounts)`: `SELECT id, status, balance FROM accounts WHERE id = $id AND kind = 'customer' FOR UPDATE`                                                                                                                                     | 55P03: 503, not stored                                 |
| 7    | `SELECT id FROM transactions WHERE reversed_transaction_id = $id`, after every lock is held; skipped only by the test seam                                                                                                                                                                                                        | 409 `already-reversed`                                 |
| 7    | every locked account not `closed` (`frozen` passes, REV-R09)                                                                                                                                                                                                                                                                      | 422 `account-not-active`                               |
| 7    | every account the reversal debits holds at least the amount it debits                                                                                                                                                                                                                                                             | 422 `insufficient-funds-for-reversal`                  |
| 7    | `credit(balance, change)` for every account the reversal credits                                                                                                                                                                                                                                                                  | 422 `balance-limit-exceeded`                           |
| 8    | `LedgerWriter.append(reversalOf(original))` (plan 002 section 4): `INSERT INTO transactions (..., kind 'reversal', reversed_transaction_id)`, `INSERT INTO ledger_entries` (the negated entries), one `UPDATE accounts` per customer account, ascending                                                                           | 23505 on the unique constraint: 409 `already-reversed` |
| 8    | `INSERT INTO audit_records (..., action 'reversal', account_ids, transaction_id, reversed_transaction_id, reason, request_id)`                                                                                                                                                                                                    |                                                        |

A 23505 at the transaction insert puts the database transaction in an error state; `ROLLBACK TO SAVEPOINT work` clears it, and the 409 is stored and committed like any business rejection (REV-R06, IDM-R14). The check for an existing reversal reads the database only after the locks, so of several concurrent reversals of one transaction, which all lock the same accounts in the same order, the first commits and every later one finds it (REV-R21). `MAX_AMOUNT_MINOR` is never read by this path (REV-R12).

Reading a reversal is `GET /transactions/{id}` of plan 003 section 3.5, which adds `reversedTransactionId` for kind `reversal` (REV-R23). No statement of either path reads `audit_records.reason`, and the logger never receives the request body, so `reason` reaches no response and no log line (REV-R16).

## 4. Domain

- `reversalOf(original)` returns a new `LedgerTransaction` and never mutates the original; it goes through `LedgerTransaction.create`, so the reversal satisfies the same invariants (REV-AC03).
- `reversal-rules.ts` gets the original's entries and the locked rows, computes each customer account's change (the negated sum of its entries in the original), and returns the first failure in the order of section 1.4, steps 5 to 8. A withdrawal's reversal debits only the settlement account, which needs no funds check (table 1.2).

## 5. Error mapping

Shared errors are in section 7 of plan 000. For a reversal:

| Typed error                    | When                                                              | Status | Type                                              | Stored for replay |
| ------------------------------ | ----------------------------------------------------------------- | ------ | ------------------------------------------------- | ----------------- |
| `MalformedRequest`             | `Idempotency-Key` missing or malformed                            | 400    | `/problems/malformed-request`                     | no                |
| `Forbidden`                    | a customer reverses, whatever id the path names                   | 403    | `/problems/forbidden`                             | no                |
| `ValidationFailed`             | `reason` invalid, or an unknown member                            | 422    | `/problems/validation-error`                      | no                |
| `NotFound`                     | the transaction does not exist or its id is not a UUID            | 404    | `/problems/not-found`                             | yes               |
| `TransactionNotReversible`     | the transaction is a reversal                                     | 422    | `/problems/transaction-not-reversible`            | yes               |
| `AlreadyReversed`              | a reversal exists, found by the check or by the unique constraint | 409    | `/problems/already-reversed`                      | yes               |
| `AccountNotActive`             | an account of the original is `closed`                            | 422    | `/problems/account-not-active`                    | yes               |
| `InsufficientFundsForReversal` | the reversal would debit an account by more than its balance      | 422    | `/problems/insufficient-funds-for-reversal`       | yes               |
| `BalanceLimitExceeded`         | the reversal would raise a balance above the limit                | 422    | `/problems/balance-limit-exceeded`                | yes               |
| `AccountLockTimeout`           | 55P03 at an account lock                                          | 503    | `/problems/service-unavailable`, `Retry-After: 1` | no                |
| `IdempotencyWaitTimeout`       | 55P03 at a key-wait step (3, 3b, 3c or a re-pass)                 | 409    | `/problems/request-in-progress`, `Retry-After: 1` | no                |

## 6. Acceptance criteria

| AC       | Level       | Phase        | Test file                                           |
| -------- | ----------- | ------------ | --------------------------------------------------- |
| REV-AC01 | integration | 08-api       | `test/integration/reversals/reversals.test.ts`      |
| REV-AC02 | integration | 08-api       | `test/integration/reversals/reversals.test.ts`      |
| REV-AC03 | unit        | 06-domain    | `test/unit/movements/reversal.test.ts`              |
| REV-AC04 | integration | 08-api       | `test/integration/reversals/authorization.test.ts`  |
| REV-AC05 | integration | 08-api       | `test/integration/reversals/authorization.test.ts`  |
| REV-AC06 | integration | 08-api       | `test/integration/reversals/at-most-once.test.ts`   |
| REV-AC07 | integration | 08-api       | `test/integration/reversals/at-most-once.test.ts`   |
| REV-AC08 | integration | 08-api       | `test/integration/reversals/at-most-once.test.ts`   |
| REV-AC09 | integration | 08-api       | `test/integration/reversals/at-most-once.test.ts`   |
| REV-AC10 | integration | 08-api       | `test/integration/reversals/business-rules.test.ts` |
| REV-AC11 | integration | 08-api       | `test/integration/reversals/business-rules.test.ts` |
| REV-AC12 | integration | 08-api       | `test/integration/reversals/business-rules.test.ts` |
| REV-AC13 | integration | 08-api       | `test/integration/reversals/business-rules.test.ts` |
| REV-AC14 | integration | 08-api       | `test/integration/reversals/business-rules.test.ts` |
| REV-AC15 | integration | 08-api       | `test/integration/reversals/request.test.ts`        |
| REV-AC16 | unit        | 08-api       | `test/unit/movements/reversal-schema.test.ts`       |
| REV-AC17 | integration | 08-api       | `test/integration/reversals/request.test.ts`        |
| REV-AC18 | integration | 08-api       | `test/integration/reversals/audit.test.ts`          |
| REV-AC19 | integration | 08-api       | `test/integration/reversals/atomicity.test.ts`      |
| REV-AC20 | unit        | 06-domain    | `test/unit/movements/lock-plan.test.ts`             |
| REV-AC21 | integration | 08-api       | `test/integration/reversals/lock-timeout.test.ts`   |
| REV-AC22 | integration | 08-api       | `test/integration/reversals/concurrency.test.ts`    |
| REV-AC23 | integration | 09-hardening | `test/integration/reversals/concurrency.test.ts`    |
| REV-AC24 | integration | 08-api       | `test/integration/reversals/business-rules.test.ts` |
| REV-AC25 | integration | 08-api       | `test/integration/reversals/read-reversal.test.ts`  |

Notes:

- REV-AC16 tests the request schema, which lives with the other Zod schemas in 08-api (ADR-0011).
- REV-AC23 starts the service with the timeouts of spec 007, so it waits for 09-hardening, like MOV-AC14.
- REV-AC14 rebuilds the app against the same database with another `MAX_AMOUNT_MINOR`, which stands for the restart.
- REV-AC18 captures every log line through the logger's destination stream (plan 000 section 9).

## 7. ACs that cannot be tested as written

None open. REV-AC08, and IDM-AC17 in spec 005, now assert what the test can observe: the hook records that it skipped the check and that the insert was refused with SQLSTATE 23505 on the unique constraint of REV-R05, and the answer is still the 409 (approved by the owner on 2026-10-08).
