# 002 · Ledger · Tasks

Ordered tasks for [plan.md](plan.md). Each task is under about an hour and starts with its test: write the failing test, then the code that makes it pass. A task names an acceptance criterion only when that criterion is proven once the task is done, because ticking it makes `npm run trace` require a passing test; building blocks name the requirement IDs they implement, and their tests carry those requirement IDs. Tick a task only in its own phase.

The tasks of 05-schema and 06-domain set up balances with `writeDirectDeposit`, as the preamble of section 3 of the spec allows.

## 05-schema

These tasks run in the cross-spec order of plan 000 section 1, across every `specs/*/tasks.md`: step 1 roles and functions, step 2 accounts, step 3 ledger, step 4 settlement accounts, step 5 audit, step 6 test helpers, step 7 the database-check ACs. Each task below names its step.

- [x] Step 3: Test first in `test/integration/ledger/ledger-schema.test.ts` (LED-R03 to LED-R07, LED-R16, LED-R17): with transfer-shaped rows between two customer accounts written directly as `scf_app`, a balanced transaction commits, on a scratch database, since its cached balances cannot match its entries before the settlement accounts and `writeDirectDeposit` exist, while a zero amount, a single entry, an unbalanced pair, a currency other than the account's or the transaction's, and an `UPDATE`, `DELETE` or `TRUNCATE` are refused; then the migration `ledger` (tables, composite foreign keys, the reversal link and its unique constraint, grants, both deferred triggers, the append-only triggers and the indexes).
- [x] Step 4: Test first in `test/integration/ledger/settlement-schema.test.ts` (LED-R08, LED-R13): the test database holds exactly one settlement account per currency, each with its code, no owner and no cached balance; then the migration `settlement-accounts`.
- [x] Step 7: Test first: LED-AC03 and LED-AC04 in `test/integration/ledger/database-checks.test.ts`, with balances set up by `writeDirectDeposit`, closing any gap they find in the migration `ledger`.
- [x] Step 7: Test first: LED-AC05 and LED-AC08 in `test/integration/ledger/database-checks.test.ts`.
- [x] Step 7: Test first: LED-AC11 in `test/integration/ledger/append-only.test.ts`.
- [x] Step 7: Test first: LED-AC12 in `test/integration/ledger/runtime-role.test.ts`, closing any privilege gap it finds in the migrations.
- [x] Step 7: Test first: LED-AC06 in `test/integration/ledger/settlement-accounts.test.ts`, on a scratch database.

## 06-domain

- [x] Test first: LED-AC22 in `test/unit/ledger/money.test.ts`; then `src/modules/ledger/domain/money.ts` and the money errors.
- [x] Test first: LED-AC01 in `test/unit/ledger/ledger-transaction.test.ts`; then the builders and `balanceChanges()` of `ledger-transaction.ts`.
- [x] Test first: LED-AC02 in `test/unit/ledger/ledger-transaction.test.ts`; then the checks of `LedgerTransaction.create` in the order of plan section 3.
- [x] Test first in `test/integration/ledger/ledger-writer.test.ts` (LED-R11, LED-R14, LED-R18): `append` writes the transaction and its entries, changes only customer balances, never updates a settlement row (its `xmin` is unchanged), and gives each entry a `created_at` taken at the insert; then `kysely-ledger.ts`.
- [x] Test first in `test/integration/ledger/system-balance.test.ts` (LED-R13, LED-R15): a settlement balance is the `numeric` sum of its entries as a string, correct beyond the `bigint` range in a rolled-back transaction; then `BalanceQueries`.
- [x] Test first: LED-AC14 in `test/integration/ledger/reconciliation.test.ts`; then `reconciliation.ts` and `kysely-reconciliation.ts`.
- [x] Test first: LED-AC16 in `test/integration/ledger/reconcile-script.test.ts`, on a scratch database, also asserting with the statements captured on the script's connection that it calls `app.set_statement_timeout(600000)` inside its transaction (SEC-R48, ADR-0021); then `npm run reconcile`, `scripts/reconcile.ts` and `src/modules/ledger/adapters/cli/reconcile.ts`.
- [x] Add the CI step `npm run reconcile` with `DATABASE_URL` set to `TEST_DATABASE_URL`, after `npm run test:integration`: LED-AC17.
- [x] Update the docs: in AGENTS.md, add `npm run reconcile` to the commands table, from 06-domain.

## 07-idempotency

No task for this spec.

## 08-api

These tasks run in the cross-spec order of plan 000 section 1 for 08-api: authentication, error handler and pipeline, account routes, idempotency wiring, movement and reversal routes, then the ACs that need them.

- [x] Test first: LED-AC20 in `test/unit/platform/config.test.ts`; then `MAX_AMOUNT_MINOR` in `src/platform/config/config.ts`.
- [ ] Test first in `test/unit/movements/movement-schemas.test.ts` (LED-R23, LED-R24): the movement amount schema accepts the configured maximum and refuses one more with one `errors` entry for `/amount`; then the refinement in `src/modules/movements/adapters/http/schemas.ts`.
- [ ] Test first: LED-AC18 and LED-AC19 in `test/integration/ledger/amount-limits.test.ts`.
- [ ] Test first: LED-AC07 in `test/integration/ledger/settlement-flows.test.ts`.
- [ ] Test first: LED-AC09 in `test/integration/ledger/system-account-locks.test.ts`.
- [ ] Test first: LED-AC10 in `test/integration/ledger/overflow.test.ts`.
- [ ] Test first: LED-AC21 in `test/integration/ledger/balance-limit.test.ts`.
- [ ] Test first: LED-AC13 in `test/integration/ledger/entry-timestamps.test.ts`.
- [ ] Test first: LED-AC23 in `test/integration/ledger/rejected-write.test.ts`, with the entry-rewrite fault of the `unit-of-work-faults` seam.
- [ ] Update the docs: the OpenAPI description of minor units, signed entry amounts and `MAX_AMOUNT_MINOR`; a runbook `docs/runbooks/reconciliation.md` on running `npm run reconcile` and reading its report; the README section on the ledger; and the follow-ups closed in ADR-0006, ADR-0007 and ADR-0018.

## 09-hardening

- [ ] Test first: LED-AC15 in `test/integration/ledger/reconciliation-concurrency.test.ts`, with the service started with `DB_POOL_ACQUIRE_TIMEOUT_MS` "10000", `REQUEST_TIMEOUT_MS` "30000" and `SHUTDOWN_TIMEOUT_MS` "30000".

## 10-runtime

No task for this spec.

## 11-e2e

No task for this spec.

## 12-infra

No task for this spec.
