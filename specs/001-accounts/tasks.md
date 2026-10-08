# 001 · Accounts · Tasks

Ordered tasks for [plan.md](plan.md). Each task is under about an hour and starts with its test: write the failing test, then the code that makes it pass. A task names an acceptance criterion only when that criterion is proven once the task is done, because ticking it makes `npm run trace` require a passing test; building blocks name the requirement IDs they implement, and their tests carry those requirement IDs. Tick a task only in its own phase.

## 05-schema

These tasks run in the cross-spec order of plan 000 section 1, across every `specs/*/tasks.md`: step 1 roles and functions, step 2 accounts, step 3 ledger, step 4 settlement accounts, step 5 audit, step 6 test helpers, step 7 the database-check ACs. Each task below names its step.

- [x] Step 2: Test first in `test/integration/accounts/accounts-table.test.ts` (ACC-R01, SYS-R08, LED-R12): as `scf_app`, a customer account row needs an owner, a status and a balance; a currency outside table 1.3, a status outside the three values, a negative balance and a `closed` row with a balance other than 0 are refused; `created_at` equals `updated_at` on insert; and `scf_app` can update only `status`, `balance` and `updated_at`; then the migration `accounts` of plan section 2.

## 06-domain

- [x] Test first in `test/unit/accounts/account.test.ts` (ACC-R11 to ACC-R16, ACC-R19): every cell of the lifecycle table of plan section 4, and `canMoveMoney()` only for `active`; then `src/modules/accounts/domain/account.ts` and `errors.ts`.
- [x] Test first in `test/integration/accounts/create-account-use-case.test.ts` (ACC-R01, ACC-R02, ACC-R04): the use case creates `active` accounts with balance 0 for the caller, several in one currency, with increasing UUIDv7 ids; then `ports.ts`, `create-account.ts` and the insert of `kysely-accounts.ts`.
- [x] Test first in `test/integration/accounts/change-status-use-case.test.ts` (ACC-R11 to ACC-R17, ACC-R26): each transition updates the status and `updated_at` and writes one audit record with old and new status; an unchanged request and a refused one write none; a system account and an unknown id are not found; then `change-account-status.ts` with the statements of plan section 3.5.
- [x] Test first in the same file (ACC-R28, ACC-R29): with a session holding `FOR UPDATE` on the row and a lock timeout of 200 ms, the use case ends with `AccountLockTimeout` after at least 200 ms, with the account and the audit table unchanged.
- [x] Test first in `test/integration/accounts/account-queries.test.ts` (ACC-R07, ACC-R09, ACC-R10, ACC-R25): reading an account as its owner, as another customer, as an operator, and a system account; then the read of `account-queries.ts`.
- [x] Test first in `test/unit/accounts/keyset-order.test.ts` (ACC-R22): positions order newest first by microsecond `createdAt`, then `id`, and "strictly after" resumes at the next position; then `src/modules/accounts/application/keyset.ts`.
- [x] Test first in the queries test (ACC-R08, ACC-R21, ACC-R22, ACC-R25): the account list and the history page newest first with `limit + 1`, resume strictly after a position at microsecond precision, never return system accounts or their entries, and return entries with their transaction's kind; then the list and history statements of plan sections 3.3 and 3.4.

## 07-idempotency

- [x] Test first in `test/integration/accounts/create-account-keyed.test.ts` (ACC-R03, IDM-R02): with a key, account creation runs inside the key step of plan 005 as the skeleton of plan 000 section 6.2 with no lookup or lock, a repeat returns the stored response and creates no account, and the same key of another user creates its own account; then wire `create-account.ts` into the idempotent runner.

## 08-api

These tasks run in the cross-spec order of plan 000 section 1 for 08-api: authentication, error handler and pipeline, account routes, idempotency wiring, movement and reversal routes, then the ACs that need them.

- [ ] Test first in `test/unit/accounts/cursor.test.ts` (ACC-R23, ACC-R30): a cursor round-trips; one altered character, random base64url, a short text, another list, user or account, and another secret are refused; then `src/modules/accounts/adapters/http/cursor.ts`, `CURSOR_SECRET` in the configuration loader, and `CURSOR_SECRET=change-me` in `.env.example`, followed by `npm run env:sync`.
- [ ] Test first: ACC-AC20 in `test/unit/accounts/keyset.test.ts`, paging with real cursors.
- [ ] Build `schemas.ts`, `presenters.ts` (timestamps truncated to milliseconds, plan section 5) and `routes.ts` for the seven routes, registered by the composition root, with `test/integration/accounts/routes.test.ts` (ACC-R07) proving a read answers the representation of section 1.3.
- [ ] Test first: ACC-AC01, ACC-AC02 and ACC-AC04 in `test/integration/accounts/create-account.test.ts`.
- [ ] Test first: ACC-AC03 in `test/integration/accounts/create-account.test.ts`.
- [ ] Test first: ACC-AC05 and ACC-AC06 in `test/integration/accounts/create-account.test.ts`.
- [ ] Test first: ACC-AC07, ACC-AC09 and ACC-AC10 in `test/integration/accounts/read-accounts.test.ts`.
- [ ] Test first: ACC-AC08, ACC-AC22 and ACC-AC24 in `test/integration/accounts/read-accounts.test.ts`.
- [ ] Test first: ACC-AC11, ACC-AC12 and ACC-AC13 in `test/integration/accounts/status-changes.test.ts`.
- [ ] Test first: ACC-AC15 and ACC-AC23 in `test/integration/accounts/status-changes.test.ts`.
- [ ] Test first: ACC-AC25 in `test/integration/accounts/status-changes.test.ts`.
- [ ] Test first: ACC-AC14 in `test/integration/accounts/status-concurrency.test.ts`, once deposits and withdrawals are served (plan 003).
- [ ] Test first: ACC-AC16 and ACC-AC17 in `test/integration/accounts/status-effects.test.ts`, once the movements of plan 003 are served.
- [ ] Test first: ACC-AC18 and ACC-AC27 in `test/integration/accounts/history.test.ts`.
- [ ] Test first: ACC-AC19 and ACC-AC21 in `test/integration/accounts/history.test.ts`.
- [ ] Test first: ACC-AC26 in `test/integration/accounts/cursor-replicas.test.ts`.
- [ ] Update the docs: the OpenAPI descriptions of the seven routes (paging, cursors, the operator view, the status lifecycle and its errors), the README section on accounts, and the Related ADRs of this spec.

## 09-hardening

No task for this spec.

## 10-runtime

No task for this spec.

## 11-e2e

No task for this spec.

## 12-infra

No task for this spec.
