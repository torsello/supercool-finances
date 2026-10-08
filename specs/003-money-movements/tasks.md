# 003 · Money movements · Tasks

Ordered tasks for [plan.md](plan.md). Each task is under about an hour and starts with its test: write the failing test, then the code that makes it pass. A task names an acceptance criterion only when that criterion is proven once the task is done, because ticking it makes `npm run trace` require a passing test; building blocks name the requirement IDs they implement, and their tests carry those requirement IDs. Tick a task only in its own phase.

## 05-schema

No task for this spec: movements add no table. The cross-spec order of the 05-schema tasks is in plan 000 section 1. The lock-timeout function and the audit table are built by plan 000, the ledger tables by plan 002.

## 06-domain

- [x] Test first: MOV-AC15 in `test/unit/movements/lock-plan.test.ts`; then `src/modules/movements/domain/lock-plan.ts`.
- [x] Test first in `test/unit/movements/movement-rules.test.ts` (MOV-R12, MOV-R16, MOV-R17): for deposits and withdrawals, the first failure of steps 5 to 8 of section 1.4 wins (status before funds, status before the balance limit); then the deposit and withdrawal rules of `movement-rules.ts`.
- [x] Test first in the same file (MOV-R13, MOV-R14, MOV-R15, MOV-R17): for transfers, funds come before any destination check; an own destination answers status, then currency; every other unavailable destination, the overflowing own one included, gives `DestinationUnavailable`; then the transfer rules.
- [x] Test first in `test/integration/movements/movement-accounts.test.ts` (MOV-R18, LED-R14): the lookup reads the immutable columns of a source and a destination without locks; the lock statement takes `FOR UPDATE` on customer accounts only, so with a session holding `FOR NO KEY UPDATE` on a settlement row a lock of that row's id returns no row at once; then `kysely-movements.ts` (lookup and lock).
- [x] Test first in `test/integration/movements/deposit-use-case.test.ts` (MOV-R01, MOV-R05, MOV-R11, MOV-R12, MOV-R24): a deposit by an operator appends the entries of table 1.1 of spec 002, raises the balance and writes one audit record; an unknown or system account is not found; a frozen account and another currency are refused with nothing written; then `deposit.ts`.
- [x] Test first in `test/integration/movements/withdrawal-use-case.test.ts` (MOV-R02, MOV-R05, MOV-R16, MOV-R24): a withdrawal by the owner, the whole balance included; another customer's account is not found; one above the balance is refused with nothing written; then `withdraw.ts`.
- [x] Test first in `test/integration/movements/transfer-use-case.test.ts` (MOV-R03, MOV-R13, MOV-R14, MOV-R15, MOV-R24): transfers to another customer and to an own account; an own frozen destination, an own other-currency destination and the conditions of `destination-unavailable` are refused with nothing written and the destination's balance unchanged; then `transfer.ts`.
- [x] Test first in `test/integration/movements/lock-wait-use-case.test.ts` (MOV-R19, MOV-R20, MOV-R23): with a session holding A1's row, a withdrawal ends with `AccountLockTimeout` after the lock timeout and writes nothing; 20 crossed transfers between two accounts at the same time all complete with no 40P01 reaching the caller.
- [x] Test first in `test/integration/movements/transaction-queries.test.ts` (MOV-R26, MOV-R27, MOV-R28): an operator gets every entry, a customer only the entries of their own accounts, and a customer with none, an unknown id and a non-UUID id are not found; then `get-transaction.ts` and the read of `kysely-movements.ts`.

## 07-idempotency

- [x] Test first in `test/integration/movements/movement-transaction.test.ts` (MOV-R06, MOV-R19, MOV-R29, IDM-R11): with the statements captured on the unit of work's connection, each movement runs the skeleton of plan 000 section 6.2 in order, the key row is its first write, the idempotency wait is set before the key insert, and the account lock timeout immediately before the first `FOR UPDATE`; then wire `deposit.ts`, `withdraw.ts` and `transfer.ts` into the idempotent runner.
- [x] Test first in the same file (MOV-R20, MOV-R21, IDM-R14): a lookup or business rejection rolls back to the savepoint and commits the stored response with no transaction, entry, balance change or audit record; an account lock timeout rolls back everything, key row included, and a second run with the same key is a first request.

## 08-api

These tasks run in the cross-spec order of plan 000 section 1 for 08-api: authentication, error handler and pipeline, account routes, idempotency wiring, movement and reversal routes, then the ACs that need them.

- [x] Test first: MOV-AC20 in `test/unit/platform/config.test.ts`; then `ACCOUNT_LOCK_TIMEOUT_MS` in `src/platform/config/config.ts`.
- [ ] Test first in `test/unit/movements/movement-schemas.test.ts` (MOV-R08, MOV-R09, MOV-R10, MOV-R30): one `errors` entry per failing field; `destinationAccountId` missing, not a string, not a UUID, or equal to the path id in any letter case is refused; then the body schemas of `src/modules/movements/adapters/http/schemas.ts`.
- [ ] Build `presenters.ts` and `routes.ts` for the four routes, registered by the composition root, with `test/integration/movements/routes.test.ts` (MOV-R25) proving a deposit answers the body of section 1.2 without `balance`.
- [ ] Test first: MOV-AC01, MOV-AC02 and MOV-AC03 in `test/integration/movements/movements.test.ts`.
- [ ] Test first: MOV-AC04 in `test/integration/movements/authorization.test.ts`.
- [ ] Test first: MOV-AC05 and MOV-AC06 in `test/integration/movements/request-validation.test.ts`.
- [ ] Test first: MOV-AC07 and MOV-AC08 in `test/integration/movements/request-validation.test.ts`.
- [ ] Test first: MOV-AC09 and MOV-AC11 in `test/integration/movements/business-rules.test.ts`.
- [ ] Test first: MOV-AC10 in `test/integration/movements/business-rules.test.ts`.
- [ ] Test first: MOV-AC12 in `test/integration/movements/lock-timeout.test.ts`.
- [ ] Test first: MOV-AC13 in `test/integration/movements/concurrency.test.ts`.
- [ ] Test first: MOV-AC16 in `test/integration/movements/audit.test.ts`.
- [ ] Test first: MOV-AC17 in `test/integration/movements/atomicity.test.ts`, with the `after-balances` fault of the `unit-of-work-faults` seam.
- [ ] Test first: MOV-AC18 in `test/integration/movements/read-transaction.test.ts`.

## 09-hardening

- [ ] Test first: MOV-AC14 in `test/integration/movements/concurrency.test.ts`, once the pool acquire, request and shutdown timeouts are configurable.
- [ ] Test first: MOV-AC19 in `test/integration/movements/lock-timeout.test.ts`.
- [ ] Update the docs: the OpenAPI descriptions of the four routes (bodies, responses, every problem type of plan section 5, the `Idempotency-Key` requirement and the retry advice for 409 and 503), the README flows for a transfer and for concurrent transfers, and the follow-ups closed in ADR-0008 and ADR-0011.

## 10-runtime

No task for this spec.

## 11-e2e

No task for this spec.

## 12-infra

No task for this spec.
