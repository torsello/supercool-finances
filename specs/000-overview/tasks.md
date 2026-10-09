# 000 · Overview · Tasks

Ordered tasks for the shared platform of [plan.md](plan.md). Each task is under about an hour and starts with its test: write the failing test, then the code that makes it pass. A task names an acceptance criterion only when that criterion is proven once the task is done, because ticking it makes `npm run trace` require a passing test; building blocks name the requirement IDs they implement, and their tests carry those requirement IDs. Tick a task only in its own phase.

## 05-schema

These tasks run in the cross-spec order of plan 000 section 1, across every `specs/*/tasks.md`: step 1 roles and functions, step 2 accounts, step 3 ledger, step 4 settlement accounts, step 5 audit, step 6 test helpers, step 7 the database-check ACs. Each task below names its step.

- [x] Step 1: Replace the role `scf` in `docker/postgres/init/01-databases.sql` with `scf_owner` and `scf_app` and the grant of plan section 3; point `TEST_DATABASE_URL` in `.github/workflows/ci.yml` at `scf_app` and add `TEST_MIGRATION_DATABASE_URL`; add `MIGRATION_DATABASE_URL` and `TEST_MIGRATION_DATABASE_URL` to `.env.example` and run `npm run env:sync`; ask the owner to update `DATABASE_URL` and `TEST_DATABASE_URL` in `.env` and run `npm run infra:reset` (ADR-0018, DEP-R05).
- [x] Step 1: Add `migrate:up` and `migrate:down` to `package.json` with node-pg-migrate over SQL files in `migrations/` and `MIGRATION_DATABASE_URL`; add the integration `globalSetup` `test/integration/global-setup.ts` that migrates the test database as `scf_owner` (ADR-0020, DEP-R04).
- [x] Step 1: Add the scratch-database part of `test/support/db.ts`: as `scf_owner`, create a database, migrate it with the migration scripts above and drop it after the test, with a test in `test/integration/support/scratch-database.test.ts` proving a scratch database is created, migrated and dropped (ADR-0020), so the step 3 ledger test can use it.
- [x] Step 1: Test first in `test/integration/platform/runtime-role.test.ts` (SEC-R29): a new `scf_app` session shows `statement_timeout` `5s` and `idle_in_transaction_session_timeout` `10s`; then the migration `runtime-role-settings`.
- [x] Step 1: Test first in `test/integration/platform/session-functions.test.ts`: under SEC-R31, as `scf_app`, `app.set_lock_timeout(300)` sets `lock_timeout` to `300ms` until the transaction ends, refuses 0 and 60001, and neither `PUBLIC` nor `scf_owner` can execute it, `scf_app` being the only role that holds `EXECUTE` on either function; and SEC-AC37 for `app.set_statement_timeout`; then the migration `app-functions` with both functions (ADR-0021).
- [x] Step 5: Test first in `test/integration/platform/audit-records.test.ts` (SYS-R23, ACC-R26): `scf_app` can insert and select audit records, cannot update, delete or truncate them, and a row whose nullable columns do not match its `action` is refused; then the migration `audit-records`.
- [x] Step 6: Test first in `test/integration/platform/database.test.ts` (LED-R27): `int8` and `numeric` columns come back from the Kysely instance as exact strings; then `src/platform/db/database.ts` and the `Database` interface in `src/platform/db/schema.ts` for the tables of plans 000, 001 and 002.
- [x] Step 6: Complete `test/support/db.ts` (runtime and owner connections, `writeDirectDeposit` with its audit record) and `test/support/sessions.ts` (row-lock sessions as `scf_owner`, waiting until a backend is blocked), each with a test in `test/integration/support/helpers.test.ts`.
- [x] Update the docs: in AGENTS.md, add `test/support/` (shared test helpers) to the repository map.

## 06-domain

- [x] Test first: SYS-AC04 in `test/unit/ledger/currency.test.ts`; then `src/modules/ledger/domain/currency.ts`.
- [x] Test first in `test/unit/platform/transaction-runner.test.ts` (SYS-R18, SYS-R19): backoff bounds for retries 1 to 7, delays with the random source at 0, 0.5 and 0.999, a 40P01 then success, three 40001 ending in `RetriesExhausted`, 23505 not retried; then `src/platform/db/transaction-runner.ts` with injected random source and sleep.
- [x] Test first in `test/unit/platform/transaction-runner.test.ts` (SYS-R11): when `ROLLBACK` fails, or the fake connection reports an unknown state, the runner releases the client with an error, so the pool destroys it, and never returns it to the pool; then that branch of `transaction-runner.ts`.
- [x] Test first in `test/unit/platform/sqlstate.test.ts` (SYS-R19, MOV-R20, IDM-R12, IDM-R13, LED-R28, REV-R06): every row of plan section 6.3; then `src/platform/db/sqlstate.ts`.
- [x] Test first in `test/integration/platform/unit-of-work.test.ts` (SYS-R11, MOV-R19, SEC-R31): a rollback to the savepoint keeps the writes before it, the lock-timeout calls go through `app.set_lock_timeout`, and the fault hook throws at a named step with nothing committed; then `src/platform/db/unit-of-work.ts`.
- [x] Test first in `test/unit/platform/uuid-v7.test.ts`: 10000 ids generated in a loop are valid UUIDv7 and strictly increasing; then `src/platform/ids/uuid-v7.ts` (section 1.3 of spec 001).
- [x] Test first in `test/integration/platform/audit-log.test.ts` (SYS-R23): the adapter writes one record with the fields of the plan's audit table; then `src/platform/audit/kysely-audit-log.ts`.
- [x] Test first in `test/unit/toolchain.test.ts`: lint fails on `Number()`, `Number.parseInt`, `parseInt` and unary `+` in `src/modules/*/domain/**` and `src/modules/*/application/**`, and on imports of `kysely`, `pg`, `fastify`, `ioredis`, `adapters/` paths or another module's internals from `application/**`; and, under SEC-R48, a test fails when the text `app.set_statement_timeout` appears in any file of `src/` other than `src/modules/ledger/adapters/cli/reconcile.ts` and `src/modules/idempotency/adapters/cli/cleanup.ts`; then extend `eslint.config.js` (ADR-0006, ADR-0010 follow-ups, ADR-0021).

## 07-idempotency

No task for this spec: the key step that fills steps 2 to 4 and 9 of the movement skeleton is built by plan 005; the capability plans wire their operations into it.

## 08-api

These tasks run in the cross-spec order of plan 000 section 1 for 08-api: authentication, error handler and pipeline, account routes, idempotency wiring, movement and reversal routes, then the ACs that need them.

- [x] Test first in `test/unit/platform/config.test.ts`: the shared integer rule of plan section 4 refuses a sign, a leading zero, an exponent, a separator, spaces and an empty string, and the error lists every invalid variable by name without its value; then `src/platform/config/config.ts`.
- [x] Test first in `test/unit/http/error-handler.test.ts` (SYS-R24, SYS-R25, SYS-R28, SYS-R29, SYS-R34): every row of plan section 7, with fixed `title` and `detail` and no internals in a 500; then `src/platform/http/problem.ts` and `error-handler.ts`.
- [x] Extend `test/unit/platform/transaction-runner.test.ts` so the exhausted retry is mapped by `toProblem` to 503, `/problems/service-unavailable` and `Retry-After: 1`: SYS-AC16.
- [x] Test first: SYS-AC06 in `test/unit/http/amount-schema.test.ts`; then `src/platform/http/schemas/amount.ts`, `currency.ts` and `ids.ts`.
- [x] Test first in `test/unit/http/validation.test.ts` (SYS-R27): Zod issues become one `errors` entry per field with `pointer` or `parameter`, in schema order then body order; then `src/platform/http/validation.ts`.
- [x] Build `src/platform/http/routes.ts` (the `/v1` prefix, the not-found handler, the hook order of plan section 5), `src/platform/logging/logger.ts`, `src/app.ts` and `src/main.ts`, with `test/integration/overview/app.test.ts` (SYS-R32, SYS-R43) proving that an unknown path answers the problem body with and without credentials.
- [x] Add `test/support/app.ts`, `test/support/test-app.ts` with the one list of the five seams of plan section 8, `test/support/tokens.ts`, `test/support/http.ts` and log capture.
- [x] Test first, once the account routes are served: SYS-AC18 in `test/integration/overview/correlation-id.test.ts`; then `src/platform/http/request-id.ts`. Then the request id tests of `test/integration/overview/app.test.ts` (an undecodable path, a request the HTTP parser refuses), which assert only a non-empty id that differs between requests, must check the generated UUIDv7 of SYS-R21.
- [x] Test first, once the account, withdrawal and deposit routes are served: SYS-AC20 and SYS-AC21 in `test/integration/overview/problem-details.test.ts`; then the mapping of parser errors to 400.
- [x] Test first, once the deposit route is served: SYS-AC23 in `test/integration/overview/order-of-checks.test.ts`.
- [x] Test first, once every route of table 1.1 is served (plans 001, 003 and 004): SYS-AC01 in `test/integration/overview/roles.test.ts`.
- [x] Test first, once the account read, withdrawal and transfer routes are served: SYS-AC03 in `test/integration/overview/foreign-accounts.test.ts`.
- [x] Test first, once the account and deposit routes are served: SYS-AC05 and SYS-AC07 in `test/integration/overview/currencies.test.ts`.
- [x] Test first, once the movement and reversal routes are served: SYS-AC08, SYS-AC11 and SYS-AC12 in `test/integration/overview/ledger-invariants.test.ts`.
- [x] Test first, once the deposit and reversal routes are served: SYS-AC24 in `test/integration/overview/test-seams.test.ts`; then `app.testSeams` and `attachedTestHooks()`.
- [x] Test first, once the account, history, deposit, status and transaction routes are served: SYS-AC25 in `test/integration/overview/system-accounts.test.ts`.
- [x] Test first, once the account read and status routes and the idempotency wiring are served: SYS-AC26 in `test/integration/overview/ignored-idempotency-key.test.ts`.
- [x] Describe the problem details schema, every problem type of plan section 7 and the `/v1` prefix in the OpenAPI document (ADR-0016 follow-up, SYS-R43).

## 09-hardening

- [x] Test first: SYS-AC02 in `test/integration/overview/authentication.test.ts`, once the metrics server of spec 007 serves `/metrics` on `METRICS_PORT`.
- [x] Test first: SYS-AC29 in `test/integration/overview/versioned-paths.test.ts`.

## 10-runtime

No task for this spec.

## 11-e2e

- [x] Add the `e2e` Vitest project to `vitest.config.ts` writing `reports/vitest-e2e.json`, and `npm run test:e2e` against the Docker Compose stack, with a smoke test that both replicas answer through nginx.
- [x] Test first: SYS-AC14 in `test/e2e/replicas.test.ts`.
- [x] Test first: SYS-AC17 in `test/e2e/load.test.ts`, with `scripts/load-test.ts` and the report in `docs/performance.md`.
- [x] Update the docs: in AGENTS.md, add `npm run test:e2e` to the commands table, from 11-e2e.

## 12-infra

- [x] Make CI run `npm run test:e2e` and `npm run trace -- --require unit,integration,e2e`, so SYS-AC14 and SYS-AC17 are enforced in CI.
- [x] Update the docs: README sections on the request pipeline, the error model and the test seams; the OpenAPI error descriptions; the Related ADRs of this spec; and the ADR follow-ups this plan closed (ADR-0003, ADR-0008, ADR-0016, ADR-0018, ADR-0019).
