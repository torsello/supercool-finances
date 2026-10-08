# 007 · Security hardening and operability · Tasks

Ordered tasks for [plan.md](plan.md). Each task is under about an hour and starts with its test: write the failing test, then the code that makes it pass. A task names an acceptance criterion only when that criterion is proven once the task is done, because ticking it makes `npm run trace` require a passing test; building blocks name the requirement IDs they implement, and their tests carry those requirement IDs. Tick a task only in its own phase.

## 05-schema

These tasks run in the cross-spec order of plan 000 section 1, across every `specs/*/tasks.md`: step 1 roles and functions, step 2 accounts, step 3 ledger, step 4 settlement accounts, step 5 audit, step 6 test helpers, step 7 the database-check ACs. Each task below names its step.

- [x] Step 7: Test first in `test/integration/security/readiness-grant.test.ts` (SEC-R24): `scf_app` can read the names in `pgmigrations` and cannot write them; then the migration `readiness-grant`.

## 06-domain

No task for this spec.

## 07-idempotency

No task for this spec.

## 08-api

These tasks run in the cross-spec order of plan 000 section 1 for 08-api: authentication, error handler and pipeline, account routes, idempotency wiring, movement and reversal routes, then the ACs that need them.

- [x] Test first: SEC-AC16 in `test/integration/security/json-logs.test.ts`, against the logger of plan 000.
- [x] Test first: SEC-AC34 in `test/integration/security/api-docs.test.ts`; then `src/platform/http/docs.ts` with the route schemas of plans 001, 003 and 004.
- [x] Export the OpenAPI document to `docs/api/openapi.yaml` with `npm run openapi:export`, lint it with `npm run openapi:lint` (Redocly) in a step of the CI job `ci`, and add `test/unit/openapi.test.ts` (SEC-R44), which fails when the committed file is out of date with the routes. The document lists only the problem types the service answers today; the 12-infra docs task adds the rest.

## 09-hardening

- [x] Test first: SEC-AC30 in `test/unit/platform/config.test.ts`; then every variable of section 1.2, `REPLICA_ID` and `MIGRATION_DATABASE_URL` in `src/platform/config/config.ts`, in one error that names each invalid variable and its rule.
- [x] Test first in `test/unit/platform/config-budget.test.ts` (SEC-R35): the budget refuses 20130 and accepts 20131, refuses a shutdown timeout below the request timeout, and names every variable involved; then the budget check.
- [x] Test first: SEC-AC31 in `test/integration/security/startup.test.ts`, with the production build as a child process.
- [x] Test first: SEC-AC07, SEC-AC08 and SEC-AC09 in `test/integration/security/body-limits.test.ts`; then `src/platform/http/body-limits.ts` and the 413 and 415 mappings.
- [x] Test first: SEC-AC11 in `test/integration/security/headers.test.ts`; then `src/platform/http/security-headers.ts`.
- [x] Test first: SEC-AC12 and SEC-AC13 in `test/integration/security/cors.test.ts`; then `src/platform/http/cors.ts`.
- [x] Test first: SEC-AC14 in `test/integration/security/trusted-proxies.test.ts`; then `src/platform/http/trust-proxy.ts`.
- [x] Test first: SEC-AC17 in `test/integration/security/redaction.test.ts`; then the redaction, the request serializer without query strings and the startup error handling of `src/platform/logging/logger.ts`.
- [x] Test first in `test/integration/security/redis-client.test.ts` (SEC-R06, SEC-R07): with Redis unreachable, the client fails a command within `REDIS_COMMAND_TIMEOUT_MS` and never queues it; then `src/platform/redis/redis.ts`.
- [x] Test first: SEC-AC02 and SEC-AC03 in `test/integration/security/user-rate-limit.test.ts`; then `src/platform/http/rate-limit.ts` as an `onRequest` hook between authentication and the role check, and `RATE_LIMIT_USER_MAX` "1000000" as the default of `test/support/app.ts`.
- [x] Test first: SEC-AC32 in `test/integration/security/metrics.test.ts`, with the 40001 fault of the `unit-of-work-faults` seam; then `src/platform/metrics/metrics.ts` and the metrics server on `METRICS_PORT`.
- [ ] Test first: SEC-AC06 in `test/integration/security/redis-down.test.ts`, with the TCP proxy of plan section 6; then the transition logs and `scf_rate_limit_store_errors_total`.
- [ ] Test first in `test/unit/platform/migrations-dir.test.ts` (SEC-R24): the resolver finds `migrations/` from the source tree and `dist/migrations/` from a build, and fails when neither exists or the folder is empty; then `src/platform/db/migrations-dir.ts`, and `npm run build` copying `migrations/*.sql` into `dist/migrations/`, so the production build ships its migrations (SEC-R24).
- [ ] Test first: SEC-AC18 and SEC-AC19 in `test/integration/security/health.test.ts`; then `src/platform/health/health.ts` with the dedicated readiness connection and the migrations check.
- [ ] Test first: SEC-AC21 in `test/unit/platform/shutdown.test.ts`; then the shutdown coordinator of `src/platform/lifecycle/shutdown.ts`.
- [ ] Test first in `test/unit/platform/shutdown.test.ts` (SEC-R27, SEC-R28): a request already answered 503 at its request timeout whose clean-up is still running keeps the coordinator waiting; the process exits 0 when that clean-up ends before `SHUTDOWN_TIMEOUT_MS`, and 1, with its connection destroyed, when it is cut off; then count those clean-ups as in-flight work in `shutdown.ts`.
- [ ] Test first: SEC-AC20 in `test/integration/security/shutdown.test.ts`; then wire the coordinator to `close-with-grace` in `src/main.ts`.
- [ ] Test first: SEC-AC27 and SEC-AC28 in `test/integration/security/pool.test.ts`; then `DB_POOL_MAX`, the acquire timeout and `PoolAcquireTimeout` in `src/platform/db/database.ts`.
- [ ] Test first: SEC-AC24 in `test/integration/security/statement-timeout.test.ts`; then the 503 mapping of 57014, not retried.
- [ ] Test first: SEC-AC25 in `test/unit/platform/request-timeout.test.ts`; then `src/platform/http/request-timeout.ts`, answering 503 at the deadline, starting no further statement and rolling back once the statement in flight ends (plan section 4, ADR-0022).
- [ ] Test first in `test/unit/platform/request-timeout.test.ts` (SEC-R33): the 503 is answered at the deadline before the statement in flight ends; that statement is awaited whatever its outcome (success, 57014, another error) before `ROLLBACK` is sent; a failed `ROLLBACK` releases the connection with an error, so it is destroyed; nothing is rolled back when no transaction is open; and no statement is ever sent on another connection to cancel it.
- [ ] Test first in `test/unit/platform/request-timeout.test.ts` (SEC-R33), with an injected clock: when the deadline passes during the retry backoff after a 40001 or 40P01, or while the request waits for a pool connection, the 503 is answered at the deadline, no `BEGIN` is sent after it, and a connection acquired after the deadline is released unused; and when the statement in flight sends no reply within the client-side limit of plan section 4, the client is released with an error, so the pool destroys it; then those branches of `request-timeout.ts` and `transaction-runner.ts`.
- [ ] Test first: SEC-AC38 in `test/unit/platform/request-timeout.test.ts`; then the commit-in-flight branch of `request-timeout.ts`.
- [ ] Add `test/support/sql-capture.ts`, with `test/integration/support/sql-capture.test.ts` proving it records every statement of a pool connection in order.
- [ ] Test first: SEC-AC22 and SEC-AC23 in `test/integration/security/database-sessions.test.ts`, SEC-AC22 reading the `pg_db_role_setting` row of `scf_app` for the current database (`setdatabase` = its oid), where the migration `runtime-role-settings` sets both timeouts.

## 10-runtime

- [ ] Write this plan's part of `docker/nginx/templates/default.conf.template`: `limit_req`, body size, timeouts, request id, `X-Forwarded-For`, access log format without query strings, `server_tokens off`, and the problem-details `error_page` locations for 429 and 413.
- [ ] Add `test/support/deployment.ts`, reading `compose.yaml` with the `yaml` package (added now as a development dependency, plan section 8) and the nginx template, with `test/unit/deployment/reader.test.ts` proving it finds the services, published ports and timeouts.
- [ ] Test first: SEC-AC26 and SEC-AC36 in `test/unit/deployment/timeouts.test.ts`.
- [ ] Test first: SEC-AC29 in `test/unit/deployment/pool-budget.test.ts`.
- [ ] Test first: SEC-AC33 in `test/unit/deployment/metrics-port.test.ts`.

## 11-e2e

- [ ] Test first: SEC-AC10 in `test/e2e/edge.test.ts`.
- [ ] Test first: SEC-AC15 in `test/e2e/correlation-id.test.ts`.
- [ ] Test first: SEC-AC04 in `test/e2e/user-rate-limit.test.ts`, with its own user C9.
- [ ] Add the response recorder to the e2e HTTP helpers and the Vitest sequencer of plan section 6, with `test/e2e/support.test.ts` proving the order and the recorder file; then test first: SEC-AC05 in `test/e2e/no-rate-limited.test.ts`.
- [ ] Test first: SEC-AC01 in `test/e2e/edge-rate-limit.test.ts`, run last by the sequencer.

## 12-infra

- [ ] Extend `test/unit/deployment/pool-budget.test.ts` and `test/unit/deployment/timeouts.test.ts` to the Terraform variables for tasks, `DB_POOL_MAX`, the parameter group, `REQUEST_TIMEOUT_MS` and the ALB idle timeout, keeping SEC-AC29 and SEC-AC36 whole.
- [ ] Add the WAF rate-based rule check to the policies run by `npm run infra:validate`, once plan 008 has added that CI step, so the step proves SEC-AC35.
- [ ] Update the docs: a runbook per operational answer (`docs/runbooks/rate-limits.md`, `docs/runbooks/timeouts-and-503.md`, `docs/runbooks/shutdown.md`), the README sections on configuration, health checks and metrics, the OpenAPI 413, 415, 429 and 503 responses, and the follow-ups closed in ADR-0013 and ADR-0019.
