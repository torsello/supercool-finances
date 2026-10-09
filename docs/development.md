# Development

How to set up the service, run it, change it and ship the change. The rules every contributor and AI agent follows are in [AGENTS.md](../AGENTS.md); this guide explains how to work within them. The diagrams of the workflow and of the service's layers are in the README: [Development workflow](../README.md#development-workflow) and [Inside the service](../README.md#inside-the-service).

## Contents

- [Setup](#setup)
- [npm scripts](#npm-scripts)
- [Make targets](#make-targets)
- [Spec-first workflow](#spec-first-workflow)
- [Project skills and guardrails](#project-skills-and-guardrails)
- [Adding a migration](#adding-a-migration)
- [Adding an endpoint](#adding-an-endpoint)
- [Commits, branches and pull requests](#commits-branches-and-pull-requests)
- [Debugging](#debugging)

## Setup

### On the host

| Prerequisite   | Why                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------ |
| Node 24        | The version in [.nvmrc](../.nvmrc); `package.json` accepts `>=24 <25`.                                 |
| Docker Compose | Postgres and Redis for the service and the integration tests, and the images the tools below run from. |

```sh
npm ci                # the locked dependencies
npm run env:sync      # creates .env from .env.example, with random secrets
npm run infra:up      # Postgres on 127.0.0.1:55432 and Redis on 127.0.0.1:6379, waits until healthy
npm run migrate:up    # applies the migrations as the owner role, MIGRATION_DATABASE_URL
npm run dev           # the service on http://localhost:3000, restarted on every change
```

`npm run dev` serves the API under `/v1`, the health checks at `/health/live` and `/health/ready`, the API reference at `/docs`, and the metrics on `http://localhost:9464/metrics`. Mint a token with `npm run token -- --sub <uuid> --role customer`.

**Never read or print `.env`.** It holds secrets. When `.env.example` gains a variable, run `npm run env:sync`: it appends only the missing keys, fills those ending in `_SECRET`, `_PASSWORD`, `_KEY` or `_TOKEN` with random values, never changes an existing one and prints names, not values. The AI's permission rules deny reading it ([below](#permission-rules)).

### With Docker only

```sh
make up          # builds the images and starts Postgres, Redis, migrate, api-1, api-2 and nginx on :8080
make seed        # the demo accounts and deposits of table 1.2 of spec 008
eval "$(make demo-env)"   # sets TOKEN, OPERATOR_TOKEN, A and B in this shell
make test        # npm run check, the integration tests and the trace gate, in the tools image
```

The `tools` service is the image's `tools` stage: the dependencies, the sources and gitleaks, on the stack's network with the demo variables of [compose.yaml](../compose.yaml). It is never started by `up`. Any npm script runs in it:

```sh
docker compose build --quiet tools && docker compose run --rm tools npm run <script>
```

The stack needs no `.env`: its values are literals in `compose.yaml`.

## npm scripts

Every script of [package.json](../package.json). The scripts that read `.env` load it with `--env-file-if-exists`, and the Vitest scripts through `process.loadEnvFile` in `vitest.config.ts`; either way a variable already set in the environment wins.

| Script                | What it does                                                                                                                                                                                      | Prerequisites                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `dev`                 | Runs `src/main.ts` with `tsx watch`, restarting on every change.                                                                                                                                  | `.env`, `infra:up`, `migrate:up`                                        |
| `build`               | Compiles with `tsconfig.build.json` into `dist/`, then copies `migrations/*.sql` and the RDS CA bundle into `dist/` (`scripts/copy-build-assets.ts`).                                             | none                                                                    |
| `start`               | Runs `dist/main.js`.                                                                                                                                                                              | `build`, the variables of the service                                   |
| `typecheck`           | `tsc` over the whole project, tests included.                                                                                                                                                     | none                                                                    |
| `lint`                | ESLint over the repository.                                                                                                                                                                       | none                                                                    |
| `format`              | Prettier writes every file.                                                                                                                                                                       | none                                                                    |
| `format:check`        | Prettier checks every file and writes nothing.                                                                                                                                                    | none                                                                    |
| `test`                | The unit project; writes `reports/vitest-unit.json`.                                                                                                                                              | none                                                                    |
| `test:integration`    | The integration project against real Postgres and Redis; migrates the test database first; writes `reports/vitest-integration.json`.                                                              | `.env` (`TEST_DATABASE_URL`, `TEST_MIGRATION_DATABASE_URL`), `infra:up` |
| `test:e2e`            | The e2e suite through nginx; builds, starts and removes its own stack under the project `scf-e2e`; writes `reports/vitest-e2e.json`.                                                              | Docker; your own stack stopped (same host ports)                        |
| `test:all`            | The unit and integration projects in one run, never e2e. Writes no JSON report, so `trace` cannot use it.                                                                                         | as `test:integration`                                                   |
| `test:coverage`       | The unit project with V8 coverage over `src/`.                                                                                                                                                    | none                                                                    |
| `check`               | `typecheck`, `lint`, `format:check` and `test`. Must pass before any commit.                                                                                                                      | none                                                                    |
| `infra:up`            | `docker compose up -d --wait postgres redis`.                                                                                                                                                     | Docker                                                                  |
| `infra:down`          | `docker compose down`: stops this project's stack and keeps the volume.                                                                                                                           | Docker                                                                  |
| `infra:reset`         | `docker compose down -v`, then `infra:up`: deletes the database volume so `docker/postgres/init` runs again.                                                                                      | Docker                                                                  |
| `env:sync`            | Creates `.env` if missing and adds the keys of `.env.example` it lacks.                                                                                                                           | none                                                                    |
| `trace`               | The traceability gate: every AC with its proof, read from the reports in `reports/`. `--require <projects>` fails on a missing report; `--write` writes `docs/traceability.md`.                   | the reports of `test`, `test:integration` and, for e2e, `test:e2e`      |
| `reconcile`           | Every cached balance against the ledger, and the per-currency sums, on `DATABASE_URL`: JSON on stdout, exit 0 clean, 1 drift, 2 cannot run.                                                       | a migrated database                                                     |
| `idempotency:cleanup` | Deletes expired idempotency keys on `DATABASE_URL` in batches of 1000, skipping rows in use: prints `{"deleted": n}`, exit 0 or 2.                                                                | a migrated database                                                     |
| `token`               | `-- --sub <uuid> --role customer\|operator`: prints a bearer token valid for 15 minutes, signed with `JWT_SECRET`, `JWT_ISSUER` and `JWT_AUDIENCE`.                                               | `.env`, or those variables                                              |
| `seed`                | Creates the demo users' accounts and deposits through the API at `http://nginx:8080` and prints them as JSON; a second run changes nothing; refuses `NODE_ENV` `production`.                      | the stack of `make up`; runs in the `tools` service                     |
| `demo-env`            | Runs the seed, then prints `TOKEN`, `OPERATOR_TOKEN`, `A` and `B` (the EUR accounts of demo-customer-1 and demo-customer-2) as single-quoted shell assignments; writes no file.                   | as `seed`                                                               |
| `migrate:up`          | Applies every pending migration on `MIGRATION_DATABASE_URL`, as the owner role.                                                                                                                   | `infra:up`                                                              |
| `migrate:down`        | Rolls back the last migration on `MIGRATION_DATABASE_URL`.                                                                                                                                        | `infra:up`                                                              |
| `openapi:export`      | Writes `docs/api/openapi.yaml` from the route schemas, with the default settings.                                                                                                                 | none (no database is reached)                                           |
| `openapi:lint`        | Redocly's recommended rules on `docs/api/openapi.yaml`; any error fails.                                                                                                                          | none                                                                    |
| `infra:validate`      | `terraform fmt -check`, `init -backend=false`, `validate`, `tflint` and `checkov` with `infra/policies/`, each from an image pinned by digest. Never `plan` or `apply`; needs no AWS credentials. | Docker                                                                  |
| `load`                | The load test of SYS-R20 through the load balancer: an open model at `LOAD_RATE_PER_SECOND` (200) for 60 s, then the reconciliation; writes `docs/performance.md` and `reports/load-test.json`.   | the stack of `make up`                                                  |
| `docs:check`          | Every tracked Markdown file: each relative link and anchor resolves, and each `mermaid` block renders with the pinned Mermaid CLI image. External URLs are not checked. Exit 0, 1 or 2.           | git, Docker                                                             |

## Make targets

The [Makefile](../Makefile) runs everything through Docker Compose except `e2e` and `load`. `COMPOSE` (default `docker compose`), `SUB` and `ROLE` can be overridden.

| Target          | What it does                                                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `up`            | Builds the images, the tools image included, and starts the stack, returning once every service is healthy.                                           |
| `observability` | The stack plus Prometheus and Grafana (`--profile observability`); Grafana at <http://localhost:3030>.                                                |
| `down`          | Stops the stack and the observability profile; keeps the database volume.                                                                             |
| `logs`          | Follows the logs of every service.                                                                                                                    |
| `seed`          | `npm run seed` in the tools service.                                                                                                                  |
| `demo-env`      | `npm run demo-env` in the tools service, for `eval "$(make demo-env)"`.                                                                               |
| `token`         | `npm run token` in the tools service: `make token` for demo-customer-1, or `make token SUB=<uuid> ROLE=operator`.                                     |
| `test`          | In the tools image, against the stack's `supercool_test`: `npm run check && npm run test:integration && npm run trace -- --require unit,integration`. |
| `reconcile`     | `npm run reconcile` in the tools service, against the stack's database.                                                                               |
| `e2e`           | `npm run test:e2e` on the host. Run `make down` first.                                                                                                |
| `load`          | `npm run load` on the host, against the stack of `make up`.                                                                                           |

Every tools target rebuilds the tools image first, from the cache when nothing changed, so it never runs older sources than the stack.

## Spec-first workflow

The order is fixed by [AGENTS.md section 2](../AGENTS.md#2-workflow-spec-first) and [ADR-0001](adr/0001-spec-driven-development-with-adrs-and-ai-agents.md). The diagram is in the [README](../README.md#development-workflow).

| Step     | Where                                       | Rule                                                                                                            |
| -------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1. Spec  | `specs/NNN-name/spec.md`                    | EARS requirements (`PFX-R01`) and Given/When/Then ACs (`PFX-AC01`), each with a level. Written with `/spec`.    |
| 2. ADR   | `docs/adr/NNNN-title.md`                    | Every decision, with at least two options. Written with `/adr`. An accepted ADR is superseded, never rewritten. |
| 3. Plan  | `plan.md` and `tasks.md` in the spec folder | Before any code. A task is a `- [ ]` line that names the AC IDs it proves.                                      |
| 4. Tests | `test/unit`, `test/integration`, `test/e2e` | Each test name contains the ID of the AC it proves: `it('MOV-AC03 ...')`.                                       |
| 5. Code  | `src/`                                      | Only then.                                                                                                      |
| 6. Trace | `npm run trace`                             | After the tests, so the reports are fresh. Every AC you implemented has a passing test.                         |

- **No behaviour without an AC.** If something is needed and no spec covers it, stop and propose a spec change.
- **The spec wins.** If code and spec disagree, the code changes. Changing a requirement or an AC needs the owner; metadata (Related ADRs, the index) does not.
- **No silent decisions.** A decision no ADR covers is presented as options with trade-offs, and the owner chooses.
- **No new dependency** without an ADR or the owner's approval in [docs/dependencies.md](dependencies.md).

**Spec status.** `Draft` while written, `Approved` once the owner accepts it, and `Implemented` for all specs together in phase 13-final-review. Every spec is `Implemented` now, so every AC must be proven.

**Ticking tasks.** Tick a task (`- [x]`) as soon as it is done. From then on `npm run trace` requires a passing test of the AC's level for every AC that task names, whatever the spec status.

**The traceability gate** ([specs/README.md](../specs/README.md#traceability-check)) reads what Vitest ran, never the test source:

- An AC is proven only by a test that passed, in the report of the project that matches its level. A unit test never proves an integration AC.
- Skipped, todo and failed tests prove nothing, and any test naming a required AC that did not pass fails the check.
- A test or task that names an undefined AC ID fails the check.
- A level-`ci` AC is proven by its `Verified by` line, which must name an `npm run <script>` that is the whole command of a step of `.github/workflows/ci.yml` that can fail the build.
- `--require unit,integration` fails when a report is missing. CI's `traceability` job adds `e2e` and `--write`, and fails when the regenerated `docs/traceability.md` differs from the committed one. When a spec, a task or a test name changes, regenerate it from three fresh reports and commit it.
- A test marked `fails`, and a test that makes no assertion, fail at runtime (`vitest.shared.ts`).

**Phases and branches.** Work is split into the phases of [AGENTS.md section 7](../AGENTS.md#7-phases), from `00-setup` to `15-demo`, one session each. Each phase is developed on `phase/NN-name`, created from an up-to-date `main` ([section 8](../AGENTS.md#8-git)).

## Project skills and guardrails

The repository ships four Claude Code skills in `.claude/skills/` and the permission rules of [.claude/settings.json](../.claude/settings.json). `.claude/settings.local.json` is not committed.

### Skills

| Skill    | What it does                                                                                                                                                                                                | When                                                | Model and effort                                                                        |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `/spec`  | Writes or updates `specs/<NNN-name>/spec.md` from its template: EARS requirements, ACs with levels and concrete values, error catalogue, open questions. New specs start `Draft`. Never writes code.        | Whenever a spec is written or changed.              | Not set: the session's model.                                                           |
| `/adr`   | Records a decision as `docs/adr/NNNN-kebab-title.md` in MADR format, with at least two real options, adds it to the specs' "Related ADRs" and to the index.                                                 | Whenever a decision is made, changed or superseded. | Not set: the session's model.                                                           |
| `/audit` | An independent, read-only adversarial review of the branch against `main`, plus uncommitted and untracked files, or of a given path, or `all`. Ends with `Verdict: fix before shipping` or `ready to ship`. | Before each push, and at the end of a phase.        | `opus`, in a forked `Plan` agent that has not seen the conversation; user-invoked only. |
| `/ship`  | Runs the gates, commits a Conventional Commit, scans the branch for secrets and pushes the phase branch; with `close phase NN`, also opens the pull request to `main`. Never changes code.                  | Only when the user runs it.                         | `sonnet`, effort `low`; user-invoked only.                                              |

`/audit` may use only Read, Grep, Glob and single read-only `git status`, `git diff`, `git log` and `git show` commands. `/ship` may use only `npm run`, `docker compose`, `git add`, `git commit`, `git status`, `git diff`, `git log`, `git restore --staged`, `git reset --soft HEAD~1`, `gitleaks`, `gh pr create` and `gh pr view`; anything else prompts.

### The gates of /ship

There are no git hooks: `.git/hooks` holds only the samples, and `package.json` has no husky or lint-staged. The gates of `/ship` are this repository's pre-commit checks. It runs them in order, one command per tool call, and stops at the first failure without committing:

1. Refuses to commit on `main`.
2. `npm run check`
3. If `compose.yaml` exists: `npm run infra:up`, then `npm run test:integration`.
4. `npm run trace -- --require unit,integration`, the same gate as CI, over the reports the two steps above just wrote.
5. If `infra/terraform` exists: `npm run infra:validate`, the same check as CI: `terraform fmt -check`, `terraform validate`, tflint and checkov with the custom policies of `infra/policies/`, each from an image pinned by digest. Any finding fails the gate.
6. Docs in sync: the touched ACs match code and tests; if a spec, task or test name changed, `npm run test:e2e`, then `npm run trace -- --require unit,integration,e2e --write`; new ADRs are in the index; every transcript in `docs/ai/transcripts/` has a row in `docs/ai/README.md`, and `close phase NN` stops until the phase's transcript exists.
7. Stages with `git add -A` and unstages only what must never be committed (`.env`, credentials, `node_modules`, `dist`, `coverage`, large binaries, `*.tfstate`).
8. Commits (see [below](#commits-branches-and-pull-requests)).
9. `gitleaks git --no-banner --redact --log-opts="origin/main..HEAD"` over every commit of the branch not yet on `main`. A finding stops the push; a finding in the new commit is undone with `git reset --soft HEAD~1`, except in a transcript, where the value is replaced with `<redacted>` and the commit amended.
10. `git push -u origin HEAD`, which asks the user. Never a force-push.

It never skips, disables or weakens a test, lint rule or check. CI runs the same checks again on every pull request, and more: `openapi:lint`, `reconcile`, `build`, the e2e suite, `docs:check`, gitleaks over the full history and the security scans ([README](../README.md#ci-and-quality-gates)).

### Permission rules

[.claude/settings.json](../.claude/settings.json) allows `npm run`, `npm test`, `npx vitest`, `npx tsc`, `npx eslint`, `npx prettier`, `docker compose`, `git status`, `git diff`, `git log` and `git show` without a prompt. The rest:

| List   | Patterns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ask`  | `Bash(git push *)`, `Bash(npm install *)`, `Bash(npm uninstall *)`, `Bash(docker compose down -v*)`, `Bash(docker compose down * -v*)`, `Bash(docker compose down --volumes*)`, `Bash(docker compose down * --volumes*)`, `Bash(npm run infra:reset*)`                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `deny` | `Bash(git push --force*)`, `Bash(git push * --force*)`, `Bash(git push -f*)`, `Bash(git push * -f)`, `Bash(git push * -f *)`, `Bash(git push * +*)`, `Bash(git push --no-verify*)`, `Bash(git push * --no-verify*)`, `Bash(git reset --hard*)`, `Bash(git clean -f*)`, `Bash(rm -rf *)`, `Bash(rm -fr *)`, `Bash(terraform apply*)`, `Bash(terraform destroy*)`, `Bash(git commit --no-verify*)`, `Bash(git commit * --no-verify*)`, `Bash(git commit -n *)`, `Bash(git commit * -n *)`, `Bash(git commit * -n)`, `Read(./.env)`, `Read(**/.env)`, `Read(**/.env.local)`, `Read(**/.env.*.local)`, `Read(**/.env.development)`, `Read(**/.env.test)`, `Read(**/.env.staging)`, `Read(**/.env.production)` |

In short, the AI may never read an env file, force-push (including a `+refspec`), skip hooks, hard-reset, `git clean`, `rm -rf`, or apply or destroy Terraform. It must ask before every push, every `npm install` or `npm uninstall`, and anything that deletes the database volume. The `.env` deny rules cover the Read tool; AGENTS.md forbids reading or printing `.env` in any way, a shell command included. The settings also set the commit attribution, `Co-authored-by: Claude <noreply@anthropic.com>`.

**Commits and pushes go only through `/ship`**, or when the owner asks ([AGENTS.md section 8](../AGENTS.md#8-git)). Nothing is committed to `main` directly, failing checks are never pushed, and pushed history is never rewritten.

## Adding a migration

Migrations are plain SQL files run by node-pg-migrate through the service's own runner, [src/platform/db/migrate.ts](../src/platform/db/migrate.ts). The same code path serves `npm run migrate:up`, the `migrate` service of `compose.yaml`, the AWS migration task and the tests.

1. **Write the spec and plan first.** A schema change belongs to an AC, like any behaviour.
2. **Name the file** `migrations/<timestamp>_<kebab-name>.sql`, with a millisecond timestamp greater than the last one (the newest is `1791468174000_readiness-grant.sql`). The runner checks that the applied migrations are a prefix of the shipped ones, in order (`checkOrder`), so a file sorted before an applied one fails.
3. **Write both directions:**

   ```sql
   -- Up Migration

   CREATE TABLE ...;
   GRANT SELECT, INSERT ON ... TO scf_app;

   -- Down Migration

   REVOKE SELECT, INSERT ON ... FROM scf_app;
   DROP TABLE ...;
   ```

4. **Grant the runtime role only what it needs** ([ADR-0018](adr/0018-two-database-roles.md)). Migrations run as `scf_owner`, which owns everything. The service connects as `scf_app`, which owns nothing and holds only the grants the migrations give it: on the ledger only `SELECT` and `INSERT`, on `accounts` `UPDATE` of `status`, `balance` and `updated_at` only. Every new table, sequence or function needs its own `GRANT`.
5. **Expand, then contract** ([ADR-0020](adr/0020-expand-then-contract-migrations.md)). Every migration must work with the version already running: add tables, nullable columns and new functions first, ship the code that uses them, and drop what the old code used only in a later release. The migrations run once, before the new replicas start.
6. **Update the Kysely types** in [src/platform/db/schema.ts](../src/platform/db/schema.ts) for any table or column the code reads.
7. **Apply it:** `npm run migrate:up`; `npm run migrate:down` rolls back the last one.

**Readiness.** `/health/ready` reads `pgmigrations` as `scf_app` and answers 503 until every migration the code ships is applied; migrations newer than the code are accepted, so the previous version stays ready during a rollout. `npm run build` copies `migrations/*.sql` into `dist/migrations/` so the production build knows what it ships.

**Tests.** The integration project's global setup, [test/integration/global-setup.ts](../test/integration/global-setup.ts), migrates the shared test database up as the owner role (`TEST_MIGRATION_DATABASE_URL`) before any test runs. A test that needs its own schema uses `withScratchDatabase` in [test/support/db.ts](../test/support/db.ts): it creates a database, migrates it (unless `migrated: false`) and drops it afterwards. [test/support/migrations.ts](../test/support/migrations.ts) wraps the same runner over the repository's `migrations/`.

**Roles and databases.** [docker/postgres/init/01-databases.sql](../docker/postgres/init/01-databases.sql) creates `scf_owner`, `scf_app`, `supercool_dev` and `supercool_test`. It runs only on an empty volume: after changing it, run `npm run infra:reset` (for the stack, `docker compose down -v`). Both delete the local database. The AWS steps are in the [deploy and migrate runbook](runbooks/deploy-and-migrate.md).

## Adding an endpoint

The worked example is the transfer, `POST /v1/accounts/{id}/transfers`, of [spec 003](../specs/003-money-movements/spec.md). The layers follow [ADR-0003](adr/0003-hexagonal-architecture-with-tactical-ddd.md): `domain/` never imports Fastify, Kysely, pg or ioredis.

| Step              | What to do                                                                                                                                                                                                                                                                                   | Transfer example                                                                                                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Spec           | Requirements, ACs with their level, and every error in the error catalogue: condition, status, problem type, stored for replay or not. Shared problem types and status rules live in spec 000.                                                                                               | `MOV-R03`, `MOV-AC03`, section 4 of spec 003                                                                                                                                                                                         |
| 2. ADR            | Only if a decision is needed that no ADR covers. Ask the owner first.                                                                                                                                                                                                                        | [ADR-0008](adr/0008-read-committed-with-ordered-pessimistic-row-locks.md), [ADR-0009](adr/0009-idempotency-inside-the-movements-transaction.md)                                                                                      |
| 3. Plan and tasks | The steps in `plan.md`, the tasks with their AC IDs in `tasks.md`.                                                                                                                                                                                                                           | [specs/003-money-movements/tasks.md](../specs/003-money-movements/tasks.md)                                                                                                                                                          |
| 4. Tests first    | Unit tests for domain rules, integration tests for HTTP and the database; each name carries its AC ID.                                                                                                                                                                                       | [test/unit/movements/lock-plan.test.ts](../test/unit/movements/lock-plan.test.ts) (`MOV-AC15`), [test/integration/movements/movements.test.ts](../test/integration/movements/movements.test.ts) (`MOV-AC03`)                         |
| 5. Domain         | Rules and typed errors, with `bigint` amounts.                                                                                                                                                                                                                                               | `transferTransaction` in [movement-rules.ts](../src/modules/movements/domain/movement-rules.ts), `planLocks` in [lock-plan.ts](../src/modules/movements/domain/lock-plan.ts), [errors.ts](../src/modules/movements/domain/errors.ts) |
| 6. Use case       | In `application/`, against ports only: lookups, locks in ascending id order, checks after the locks, the ledger append, the audit record.                                                                                                                                                    | [transfer.ts](../src/modules/movements/application/transfer.ts), [ports.ts](../src/modules/movements/application/ports.ts), [steps.ts](../src/modules/movements/application/steps.ts)                                                |
| 7. Adapter        | Kysely implementations of the ports, parameterized SQL only.                                                                                                                                                                                                                                 | [kysely-movements.ts](../src/modules/movements/adapters/persistence/kysely-movements.ts)                                                                                                                                             |
| 8. Route          | In `adapters/http/routes.ts`: Zod schemas for params, query, body and response, `attachValidation: true`, and `config.roles` from `rolesFor`. Add the route to `ROUTE_ROLES` in [permissions.ts](../src/modules/auth/application/permissions.ts).                                            | [routes.ts](../src/modules/movements/adapters/http/routes.ts), [schemas.ts](../src/modules/movements/adapters/http/schemas.ts), [presenters.ts](../src/modules/movements/adapters/http/presenters.ts)                                |
| 9. Idempotency    | A money-moving POST runs through the keyed handler: `deps.keyed.hooks({ required: true })` on the route, and `deps.keyed.answer(...)` with an `operation` that validates the request and runs the use case inside the key's transaction, so the key row is its first write.                  | [keyed-handler.ts](../src/modules/idempotency/adapters/http/keyed-handler.ts)                                                                                                                                                        |
| 10. Errors        | Map each new domain error to its problem type in `REJECTIONS` of `toProblem`, [src/platform/http/error-handler.ts](../src/platform/http/error-handler.ts), and add the type, status, title and detail to `PROBLEM_TYPES` in [src/platform/http/problem.ts](../src/platform/http/problem.ts). | `InsufficientFunds` → `/problems/insufficient-funds`                                                                                                                                                                                 |
| 11. Wiring        | The composition root, [src/app.ts](../src/app.ts), builds the adapters and passes them to the module's routes.                                                                                                                                                                               | `movementRoutes({ keyed, transactions, ... })`                                                                                                                                                                                       |
| 12. OpenAPI       | Summary and description in the module's `adapters/http/openapi.ts`; then `npm run openapi:export` and `npm run openapi:lint`. A unit test, [test/unit/openapi.test.ts](../test/unit/openapi.test.ts), fails when the committed `docs/api/openapi.yaml` is out of date.                       | `MOVEMENT_ROUTE_DOCS` in [openapi.ts](../src/modules/movements/adapters/http/openapi.ts)                                                                                                                                             |
| 13. Docs          | README, runbooks and the spec's index entries still match the code. Tick the tasks, run the tests and `npm run trace`.                                                                                                                                                                       |                                                                                                                                                                                                                                      |

Role checks run before any id or body is looked at, so a customer route refuses an operator with 403 whatever the input. A foreign or unknown account answers 404, never 403. Business rejections are stored for replay; unexpected errors are not.

## Commits, branches and pull requests

- **Branch per phase:** `phase/NN-name`, from an up-to-date `main`. Nothing is committed to `main` directly.
- **Conventional Commits:** `type(scope): summary`, under 72 characters, with type `feat`, `fix`, `test`, `docs`, `refactor`, `chore`, `ci` or `build`.
- **Body:** what changed and why in two to five lines, then `Covers: <AC IDs>` when ACs are touched and `Phase: <NN-name>`, then, after a blank line, the trailers: `Co-authored-by: Claude <noreply@anthropic.com>` and the `Claude-Session: <url>` line Claude Code adds.
- **Pull request:** `/ship close phase NN ...` opens `Phase NN-name: <summary>` to `main`, listing what the phase delivered, the ACs covered, its transcripts and the last `/audit` verdict. The owner merges it with a merge commit once CI is green.
- **Never** force-push, rewrite pushed history, commit `.env` or skip hooks.

A real commit, `06bb41f`:

```text
docs: align spec 007 section 1.9 with the role settings and log part 2

Section 1.9 of spec 007 now names ALTER ROLE <runtime role> IN DATABASE
<database> SET, as plan 000 section 3 and spec 008 already do; the
owner's approval is recorded in plan 000 section 11 (no requirement or
AC changed). Adds the transcript of the final review, part 2, and its
row in docs/ai/README.md.

Covers: SEC-AC24
Phase: 13-final-review

Co-authored-by: Claude <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_<id>
```

Every AI session is exported to `docs/ai/transcripts/` and listed in [docs/ai/README.md](ai/README.md).

## Debugging

| Need                    | How                                                                                                                                                                                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| More log lines          | `LOG_LEVEL=debug npm run dev` (or `trace`). The service's own lines are at `info`, `warn`, `error` and `fatal`; lower levels add what Fastify and its plugins log. The stack's level is the literal `info` in `compose.yaml`.                                                            |
| Readable logs           | Logs are JSON lines, one per event ([observability](observability.md#logs)). Filter them by `reqId` with `grep`, or read them with any JSON tool you have.                                                                                                                               |
| One request's log lines | Send your own `X-Request-Id` (matching `[A-Za-z0-9._:-]{1,128}`) or read it from the response or the problem body's `requestId`. It is the `reqId` of every service line and the `requestId` of nginx's: `docker compose logs api-1 api-2 nginx \| grep <id>`.                           |
| Why a 503               | The service logs `service unavailable` at `warn` with `cause` and `sqlstate`. See the [timeouts runbook](runbooks/timeouts-and-503.md).                                                                                                                                                  |
| Why a 500               | `request failed` at `error`, with the error and its `sqlstate` (and `constraint` for a refused ledger write). The response body never holds the error.                                                                                                                                   |
| Why not ready           | `/health/ready` logs `not ready` at `warn` with `check` `database` or `migrations`. `migrations` means a shipped migration is not applied: run `npm run migrate:up`, or recreate an old volume.                                                                                          |
| Ledger drift            | `npm run reconcile` on the host, `make reconcile` for the stack. See the [reconciliation runbook](runbooks/reconciliation.md).                                                                                                                                                           |
| Metrics                 | Host: `curl http://localhost:9464/metrics`. Stack (the port is never published): `docker compose exec api-1 wget -qO- http://127.0.0.1:9464/metrics`. Or `make observability` and Grafana at <http://localhost:3030>.                                                                    |
| SQL                     | `docker compose exec postgres psql -U scf_owner supercool_dev` (or `supercool_test`). Connect as `-U scf_app` to see what the service may do.                                                                                                                                            |
| One test file           | `npx vitest run --project integration test/integration/movements/movements.test.ts`, or `--project unit`. One AC: add `-t 'MOV-AC03'`. These write no JSON report, so run the full script before `npm run trace`.                                                                        |
| Faults on purpose       | `buildTestApp` in [test/support/test-app.ts](../test/support/test-app.ts) attaches the test seams: unit-of-work faults, a throwing route at `/v1/test/throw`, an extra response member, a connection destroyed after commit and a skipped reversal check. The production app never does. |

**Common errors.**

| Message                                                    | Fix                                                                                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TEST_DATABASE_URL is not set. Run "npm run env:sync" ...` | Run `npm run env:sync` and `npm run infra:up`.                                                                                                                |
| The service exits 1 at startup naming variables            | A setting is invalid; the message names each variable and its rule, never its value. Compare with [.env.example](../.env.example) and run `npm run env:sync`. |
| `another migration run holds the migration lock`           | Another `migrate` is running; run it again once it has ended.                                                                                                 |
| `the order check failed`                                   | A migration is missing or sorts before one already applied. Fix the file name, or recreate the local database with `npm run infra:reset`.                     |
| `trace` reports `missing` or `unverified`                  | Run `npm test` and `npm run test:integration` (and `npm run test:e2e` for e2e ACs) before it; check the test name holds the AC ID and the right level.        |
| `test:e2e` fails to bind ports                             | Your own stack holds them: `make down` first. More in the README's [Troubleshooting](../README.md#troubleshooting).                                           |
| `docs:check` fails                                         | A relative link or anchor does not resolve, or a Mermaid block does not render; the message names the file and line.                                          |
