# 005 · Idempotency · Tasks

Ordered tasks for [plan.md](plan.md). Each task is under about an hour and starts with its test: write the failing test, then the code that makes it pass. A task names an acceptance criterion only when that criterion is proven once the task is done, because ticking it makes `npm run trace` require a passing test; building blocks name the requirement IDs they implement, and their tests carry those requirement IDs. Tick a task only in its own phase.

## 05-schema

These tasks run in the cross-spec order of plan 000 section 1, across every `specs/*/tasks.md`: step 1 roles and functions, step 2 accounts, step 3 ledger, step 4 settlement accounts, step 5 audit, step 6 test helpers, step 7 the database-check ACs. Each task below names its step.

- [x] Step 7: Test first: IDM-AC20 in `test/integration/idempotency/key-table.test.ts`; then the migration `idempotency-keys` with the table, the deferred completeness trigger, the expiry index and the grants of plan section 2.
- [x] Step 7: Test first in the same file (IDM-R04, IDM-R18): as `scf_app`, keys are unique per user and compared exactly, case included; a key of 256 characters and a fingerprint that is not 64 lowercase hex characters are refused; and `scf_app` can update and delete key rows.

## 06-domain

No task for this spec.

## 07-idempotency

- [x] Test first: IDM-AC02 in `test/unit/idempotency/idempotency-key.test.ts`; then `src/modules/idempotency/domain/idempotency-key.ts`.
- [x] Test first: IDM-AC06 in `test/unit/idempotency/fingerprint.test.ts`, with the canonical forms of RFC 8785 for key order at every level, whitespace, string escapes and arrays; then `fingerprint.ts`.
- [x] Test first in `test/unit/idempotency/outcome.test.ts` (IDM-R14 to IDM-R17): every row of section 1.3 of the spec maps to stored or not stored, and to a rollback to the savepoint or a full rollback; then `outcome.ts`.
- [x] Test first in `test/unit/idempotency/idempotent-runner.test.ts` (IDM-R12, IDM-R13): with a fake key store and unit of work, a 55P03 at the key insert ends in `IdempotencyWaitTimeout`, one after it in `AccountLockTimeout`, both roll back everything, and neither is retried; then the step tracking of `idempotent-runner.ts`.
- [x] Test first in `test/integration/idempotency/key-step.test.ts` (IDM-R06, IDM-R07, IDM-R09, IDM-R11, IDM-R15, IDM-R21): with a fake operation, the key insert is the first write after `app.set_lock_timeout`; a repeat with the same fingerprint returns the stored bytes and writes nothing; another fingerprint is refused; an expired row is replaced; then `kysely-key-store.ts` and the claim, read and complete statements of plan section 3.
- [x] Test first in `test/integration/idempotency/key-step.test.ts` (IDM-R21): the test wraps the key store's connection so that, right after the step 3 insert returns no row for an expired key, a separate session deletes that row; the request goes back to step 3, claims the key and runs as a first request; then that branch of `idempotent-runner.ts` and `kysely-key-store.ts`.
- [x] Test first in `test/integration/idempotency/key-step.test.ts` (IDM-R11, IDM-R12): with `IDEMPOTENCY_WAIT_TIMEOUT_MS` 2000, an expired key whose replacement by another session makes the request wait at step 3, and then at step 3b behind a third session's replacement, ends with `IdempotencyWaitTimeout`; the main assertions are deterministic: each `lock_timeout` set before step 3b or a re-pass equals the time left until the key-wait deadline, and the `lock_timeout` values used by the attempt sum to at most 2000 ms; the only wall-clock assertion is a generous limit, the whole wait from step 2 below 4000 ms; then the key-wait deadline of `idempotent-runner.ts`.
- [x] Test first in the same file (IDM-R10, IDM-R14, IDM-R16, IDM-R17): a second claim of the same key waits for the first and then replays its result, or runs as a first request when the first rolled back; a stored rejection rolls back to the savepoint and commits only the key row; a validation error, a 500 and a 503 leave no key row; then the outcome handling of `idempotent-runner.ts`.
- [x] Test first: IDM-AC24 in `test/integration/idempotency/cleanup-script.test.ts`, on a scratch database, also asserting with the statements captured on the script's connection that each batch calls `app.set_statement_timeout(600000)` inside its transaction (SEC-R48, ADR-0021); then `src/modules/idempotency/adapters/cli/cleanup.ts`, its executable entry point `src/cli/idempotency-cleanup.ts`, compiled into `dist/`, and `npm run idempotency:cleanup` running that entry point.
- [x] Update the docs: in AGENTS.md, add `npm run idempotency:cleanup` to the commands table, from 07-idempotency, and `src/cli/` (executable entry points compiled into `dist/`) to the repository map.

## 08-api

These tasks run in the cross-spec order of plan 000 section 1 for 08-api: authentication, error handler and pipeline, account routes, idempotency wiring, movement and reversal routes, then the ACs that need them.

- [x] Test first: IDM-AC25 in `test/unit/platform/config.test.ts`; then `IDEMPOTENCY_WAIT_TIMEOUT_MS` and `IDEMPOTENCY_KEY_TTL_SECONDS` in `src/platform/config/config.ts`.
- [x] Extend `test/unit/idempotency/idempotent-runner.test.ts` so both typed errors are mapped by `toProblem` to 409 `/problems/request-in-progress` and 503 `/problems/service-unavailable`, each with `Retry-After: 1`: IDM-AC14.
- [x] Build `key-header.ts` and `replay.ts` and wire the runner into the composition root, with `test/integration/idempotency/http-replay.test.ts` (IDM-R07) proving a replay carries the stored `Content-Type` and `Location`, the current `X-Request-Id` and `Idempotent-Replayed: true`.
- [x] Test first: IDM-AC01 and IDM-AC03 in `test/integration/idempotency/key-required.test.ts`.
- [x] Test first: IDM-AC04 in `test/integration/idempotency/account-creation.test.ts`.
- [x] Test first: IDM-AC05 in `test/integration/idempotency/key-scope.test.ts`.
- [x] Test first: IDM-AC07 and IDM-AC08 in `test/integration/idempotency/replay.test.ts`, the second with the `extra-response-member` seam.
- [x] Test first: IDM-AC09 in `test/integration/idempotency/key-reused.test.ts`.
- [x] Test first: IDM-AC15 and IDM-AC16 in `test/integration/idempotency/stored-rejections.test.ts`.
- [x] Test first: IDM-AC17 in `test/integration/idempotency/stored-rejections.test.ts`, with the `skip-existing-reversal-check` seam and its record.
- [x] Test first: IDM-AC18 and IDM-AC19 in `test/integration/idempotency/not-stored.test.ts`, the second with the `unit-of-work-faults` seam.
- [x] Test first: IDM-AC21 in `test/integration/idempotency/lost-response.test.ts`, with the `destroy-connection-after-commit` seam on a TCP port.
- [x] Test first: IDM-AC22 and IDM-AC23 in `test/integration/idempotency/expiry.test.ts`.

## 09-hardening

- [ ] Test first: IDM-AC10, IDM-AC11 and IDM-AC12 in `test/integration/idempotency/concurrent-keys.test.ts`, once the request and shutdown timeouts are configurable.
- [ ] Test first: IDM-AC13 in `test/integration/idempotency/wait-timeout.test.ts`.
- [ ] Update the docs: the OpenAPI description of the `Idempotency-Key` header on every route that takes it, the replay header, the TTL and the retry advice of section 1.5 of spec 008; a runbook `docs/runbooks/idempotency-cleanup.md`; the README flow for a duplicate request; and the follow-ups closed in ADR-0009.

## 10-runtime

No task for this spec.

## 11-e2e

No task for this spec.

## 12-infra

No task for this spec: the hourly cleanup schedule is built and checked by plan 008.
