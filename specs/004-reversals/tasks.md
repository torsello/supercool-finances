# 004 · Reversals · Tasks

Ordered tasks for [plan.md](plan.md). Each task is under about an hour and starts with its test: write the failing test, then the code that makes it pass. A task names an acceptance criterion only when that criterion is proven once the task is done, because ticking it makes `npm run trace` require a passing test; building blocks name the requirement IDs they implement, and their tests carry those requirement IDs. Tick a task only in its own phase.

## 05-schema

These tasks run in the cross-spec order of plan 000 section 1, across every `specs/*/tasks.md`: step 1 roles and functions, step 2 accounts, step 3 ledger, step 4 settlement accounts, step 5 audit, step 6 test helpers, step 7 the database-check ACs. Each task below names its step.

- [x] Step 7: Test first in `test/integration/reversals/reversal-link.test.ts` (REV-R05): written directly to the database by `scf_app`, a reversal row without a link, a deposit row with one, and a second reversal of the same transaction are refused, the original and the first reversal written directly with their cached balance changes so the test database stays reconciled, the last with SQLSTATE 23505 on `transactions_reversed_transaction_id_key` at its insert; the link column, its unique constraint and `transactions_reversal_link` are part of the migration `ledger` written in step 3 by plan 002, and this task fixes any gap the test finds there.

## 06-domain

- [x] Test first: REV-AC03 in `test/unit/movements/reversal.test.ts`; then `reversalOf` in `src/modules/ledger/domain/ledger-transaction.ts` and `TransactionNotReversible`.
- [x] Test first: REV-AC20 in `test/unit/movements/lock-plan.test.ts`, reusing `planLocks` over the original's entries.
- [x] Test first in `test/unit/movements/reversal-rules.test.ts` (REV-R06, REV-R08 to REV-R11, REV-R22): steps 5 to 8 of section 1.4 in order, `frozen` passing and `closed` failing, funds checked on the accounts the reversal debits only, and the balance limit on those it credits; then `src/modules/movements/domain/reversal-rules.ts`.
- [x] Test first in `test/integration/reversals/reverse-use-case.test.ts` (REV-R01, REV-R02, REV-R15, REV-R18): reversing a deposit, a withdrawal and a transfer appends the negated entries, changes the customer balances, leaves the original's rows unchanged and writes one audit record with the reason; an unknown id is not found and a reversal is not reversible; then `reverse.ts` and the lookup of the original in `kysely-movements.ts`.
- [x] Test first in the same file (REV-R05, REV-R06): with the existing-reversal check skipped through the hook point, the hook records the skip and the `cause` of the `AlreadyReversed` the ledger writer threw for the second reversal's insert (23505 on `transactions_reversed_transaction_id_key`), and the use case ends with `AlreadyReversed`, not an internal error; then the hook point in `reverse.ts` and the mapping in `kysely-ledger.ts`.
- [x] Test first in `test/integration/reversals/reverse-lock-wait.test.ts` (REV-R19, REV-R20): with a session holding A1's row, a reversal ends with `AccountLockTimeout` and writes nothing; a reversal and a transfer racing on the same accounts never let a balance go below zero.

## 07-idempotency

- [x] Test first in `test/integration/reversals/reversal-transaction.test.ts` (REV-R17, IDM-R14): with the statements captured on the unit of work's connection, a reversal runs the skeleton of plan 000 section 6.2 in the order of plan section 3; a rejection, the 23505 path included, rolls back to the savepoint and commits only the stored response; a lock timeout rolls back everything, key row included; then wire `reverse.ts` into the idempotent runner.

## 08-api

These tasks run in the cross-spec order of plan 000 section 1 for 08-api: authentication, error handler and pipeline, account routes, idempotency wiring, movement and reversal routes, then the ACs that need them.

- [x] Test first: REV-AC16 in `test/unit/movements/reversal-schema.test.ts`; then the reversal body schema in `src/modules/movements/adapters/http/schemas.ts`.
- [x] Build the reversal presenter and route, registered by the composition root, with `test/integration/reversals/routes.test.ts` (REV-R16) proving the response has the fields of section 1.3 and no `reason`.
- [x] Test first: REV-AC01 and REV-AC02 in `test/integration/reversals/reversals.test.ts`.
- [x] Test first: REV-AC04 and REV-AC05 in `test/integration/reversals/authorization.test.ts`.
- [x] Test first: REV-AC06 and REV-AC09 in `test/integration/reversals/at-most-once.test.ts`.
- [x] Test first: REV-AC07 in `test/integration/reversals/at-most-once.test.ts`.
- [x] Test first: REV-AC08 in `test/integration/reversals/at-most-once.test.ts`, with the `skip-existing-reversal-check` seam, asserting from the hook's record that the check was skipped and the insert refused with SQLSTATE 23505 on `transactions_reversed_transaction_id_key`.
- [x] Test first: REV-AC10, REV-AC11 and REV-AC12 in `test/integration/reversals/business-rules.test.ts`.
- [x] Test first: REV-AC13, REV-AC14 and REV-AC24 in `test/integration/reversals/business-rules.test.ts`.
- [x] Test first: REV-AC15 and REV-AC17 in `test/integration/reversals/request.test.ts`.
- [x] Test first: REV-AC18 in `test/integration/reversals/audit.test.ts`.
- [x] Test first: REV-AC19 in `test/integration/reversals/atomicity.test.ts`, with the `after-balances` fault of the `unit-of-work-faults` seam.
- [x] Test first: REV-AC21 in `test/integration/reversals/lock-timeout.test.ts`.
- [x] Test first: REV-AC22 in `test/integration/reversals/concurrency.test.ts`.
- [x] Test first: REV-AC25 in `test/integration/reversals/read-reversal.test.ts`.

## 09-hardening

- [ ] Test first: REV-AC23 in `test/integration/reversals/concurrency.test.ts`, once the pool acquire, request and shutdown timeouts are configurable.
- [ ] Update the docs: the OpenAPI description of the reversal route (body, response, every problem type of plan section 5, and that `reason` is never returned), the README section on corrections, and the Related ADRs of this spec.

## 10-runtime

No task for this spec.

## 11-e2e

No task for this spec.

## 12-infra

No task for this spec.
