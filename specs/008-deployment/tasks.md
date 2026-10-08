# 008 · Deployment · Tasks

Ordered tasks for [plan.md](plan.md). Each task is under about an hour and starts with its test: write the failing test, then the code that makes it pass. A task names an acceptance criterion only when that criterion is proven once the task is done, because ticking it makes `npm run trace` require a passing test; building blocks name the requirement IDs they implement, and their tests carry those requirement IDs. Tick a task only in its own phase.

## 05-schema

These tasks run in the cross-spec order of plan 000 section 1, across every `specs/*/tasks.md`: step 1 roles and functions, step 2 accounts, step 3 ledger, step 4 settlement accounts, step 5 audit, step 6 test helpers, step 7 the database-check ACs. Each task below names its step.

- [ ] Step 1: Point the `postgres` healthcheck of `compose.yaml` at `scf_owner`, since the role `scf` is replaced by plan 000, and check that `npm run infra:reset` turns healthy and `npm run test:integration` passes (DEP-R05).

## 06-domain

No task for this spec.

## 07-idempotency

No task for this spec.

## 08-api

No task for this spec.

## 09-hardening

No task for this spec: `REPLICA_ID` and `MIGRATION_DATABASE_URL` are validated by the configuration loader of plan 007.

## 10-runtime

- [ ] Test first in `test/integration/deployment/migrate.test.ts` (DEP-R04, DEP-R05): `src/platform/db/migrate.ts` applies every migration to a scratch database as `scf_owner`, a second run applies nothing and exits 0, and a failing migration exits non-zero; then `migrate.ts` and its executable entry point `src/cli/migrate.ts`, compiled into `dist/`, with `npm run migrate:up` and the test helpers switched to it.
- [ ] Test first: DEP-AC05 in `test/unit/deployment/demo-secrets.test.ts`; then the demo values in `compose.yaml` and their refusal in production in `src/platform/config/config.ts`.
- [ ] Test first in `test/unit/deployment/healthcheck.test.ts` (DEP-R21): the script exits 0 when `/health/live` answers 200 and 1 otherwise; then `src/healthcheck.ts`.
- [ ] Test first: DEP-AC12 in `test/unit/deployment/dockerfile.test.ts`; then the `Dockerfile` and `.dockerignore`, relying on the copy of `migrations/` into `dist/migrations/` that `npm run build` makes since 09-hardening.
- [ ] Build the full `compose.yaml` of plan section 3, with `test/unit/deployment/compose.test.ts` (DEP-R02, DEP-R06, DEP-R08) proving the dependency conditions, the published ports on `127.0.0.1` only and the absence of `env_file`.
- [ ] Write this plan's part of the nginx template (upstream with `resolve`, `worker_processes 1` with a comment naming DEP-R15 and the round robin it keeps, retries, gateway `error_page`) and pin an nginx 1.28 stable image by version and digest, with `test/unit/deployment/nginx.test.ts` (DEP-R15, DEP-R16) proving the retry directives and the problem body of the gateway errors.
- [ ] Test first in `test/unit/platform/logger.test.ts` (DEP-R14): every line carries `replicaId` from `REPLICA_ID` or the host name; then the logger change, and a check in the same file that no response header or body holds it.
- [ ] Test first: DEP-AC07 in `test/unit/deployment/seed.test.ts`; then the guards of `scripts/seed.ts`.
- [ ] Test first in `test/unit/deployment/seed.test.ts` (DEP-R10, DEP-R11): with a fake API, a first run creates the accounts and deposits of table 1.2 and a second run, after every key expired, creates and moves nothing and prints the same JSON; then the rest of `runSeed` and `npm run seed`.
- [ ] Test first: DEP-AC25 in `test/integration/deployment/gitleaks.test.ts`; then `.gitleaks.toml` only if the scan flags a demo value.
- [ ] Update the docs: in AGENTS.md, add `npm run seed` and the Docker Compose commands of the full stack to the commands table, from 10-runtime, and `docker/` (Postgres init script, nginx template) and the `Dockerfile` to the repository map.

## 11-e2e

- [ ] Add `test/e2e/support/stack.ts` with the project name, port check, build from the working tree and log reader of plan section 5, and the first group of the e2e sequencer, with `test/e2e/stack-support.test.ts` proving it starts and stops a stack of its own project only.
- [ ] Test first: DEP-AC01 and DEP-AC02 in `test/e2e/stack-start.test.ts`, DEP-AC01 from a clone of `HEAD` with the warning of plan section 5.
- [ ] Test first: DEP-AC03 in `test/e2e/stack-failed-migration.test.ts`.
- [ ] Test first: DEP-AC04 in `test/e2e/migrations.test.ts`.
- [ ] Test first: DEP-AC06 and DEP-AC08 in `test/e2e/seed.test.ts`.
- [ ] Test first: DEP-AC09 in `test/e2e/replicas-round-robin.test.ts`.
- [ ] Test first: DEP-AC10 in `test/e2e/gateway-errors.test.ts`.
- [ ] Test first: DEP-AC13 in `test/e2e/container.test.ts`.
- [ ] Add the retrying client of section 1.5 to the e2e support, with a test in `test/e2e/stack-support.test.ts` (DEP-R17) proving its retry rules against a fake server; then test first: DEP-AC11 in `test/e2e/replica-loss.test.ts`.

## 12-infra

- [ ] Write `infra/terraform/` (root configuration with an empty `backend` block, and the `network` module), and `npm run infra:validate` with `scripts/infra-validate.sh` running each tool from a pinned image.
- [ ] Document in `docs/deployment/aws.md` the one-time bootstrap step, run before the first migration task: with the RDS master credentials from Secrets Manager, create `scf_owner` (`LOGIN CREATEROLE`) and `scf_app` (`LOGIN`), each with the password of its own secret, and `GRANT scf_app TO scf_owner WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`, the same as `docker/postgres/init/01-databases.sql` (DEP-R05, DEP-R28, ADR-0018); the master credentials are used for nothing else.
- [ ] Write the `edge` module with the WAF web ACL, and its policies in `infra/policies/`.
- [ ] Write the `service` module (service, migration and cleanup task definitions, autoscaling, the hourly schedule) and its policies.
- [ ] Write the `database`, `cache` and `secrets` modules and their policies.
- [ ] Write the `observability` module with the log groups and the alarms of section 1.8, and its policies.
- [ ] Add the CI step `npm run infra:validate` to the `ci` job, passing on the modules above: DEP-AC15, DEP-AC16, DEP-AC17, DEP-AC18, DEP-AC19, DEP-AC20, DEP-AC21, DEP-AC22, DEP-AC23 and DEP-AC26.
- [ ] Test first: DEP-AC24 in `test/unit/deployment/no-terraform-apply.test.ts`.
- [ ] Test first: DEP-AC14 in `test/unit/deployment/aws-doc.test.ts`; then `docs/deployment/aws.md`.
- [ ] Update the docs: in AGENTS.md, `npm run infra:validate` in the commands table, from 12-infra, and `infra/policies/` and `docs/deployment/` in the repository map; the README sections on running the stack, seeding, minting tokens with Docker only and the AWS architecture; a runbook `docs/runbooks/deploy-and-migrate.md`; and the follow-ups closed in ADR-0014, ADR-0015, ADR-0019 and ADR-0020.
