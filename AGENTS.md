# AGENTS.md — working agreement for AI agents

## 1. What this is

A balance service for SuperCool Finances: customer accounts, a double-entry ledger, deposits, withdrawals, transfers and reversals. It is built for the take-home challenge in [docs/challenge.md](docs/challenge.md). Quality over quantity: fewer features, done correctly and proven by tests.

## 2. Workflow: spec first

1. **Spec**: `specs/NNN-name/spec.md` with EARS requirements and acceptance criteria. AC IDs look like `MOV-AC03` (module prefix, `AC`, two digits).
2. **ADR**: every decision is recorded in `docs/adr/`.
3. **Plan**: `plan.md` and `tasks.md` in the spec folder, before any code.
4. **Tests first**: each test name contains the ID of the AC it proves.
5. **Code**: only then.

Rules:

- No behaviour without an AC. If something is needed and no spec covers it, stop and propose a spec change.
- If code and spec disagree, the spec wins. Ask before changing a spec's requirements or acceptance criteria. Metadata (Related ADRs, the index) can be updated without asking.
- If a decision is not covered by an ADR, present the options with trade-offs and ask. Never decide silently.
- No new dependency without an ADR or the owner's approval recorded in [docs/dependencies.md](docs/dependencies.md).
- Spec status: `Draft` while writing, `Approved` once the owner accepts it. All specs move to `Implemented` together in the final review phase.
- When a task in `tasks.md` is done, tick it (`- [x]`). Tasks are `- [ ]` or `- [x]` lines that name their AC IDs on that line. From then on `npm run trace` requires a passing test of the right level for every AC the task names, whatever the spec status.
- After each implementation step, run the tests and then `npm run trace`, and confirm every AC you implemented has a passing test.

## 3. Non-negotiables

**Money**

- Integer minor units only: `bigint` in the domain; decimal-digit strings (`"1050"`) plus an ISO 4217 currency in the API.
- Never `number`, floats or `parseFloat` for amounts.
- The minor-unit exponent comes from the currency table in `specs/000-overview/spec.md`.

**Consistency**

- PostgreSQL is the only source of truth. No in-process state for locks, idempotency, sessions or rate limits: several replicas run behind a load balancer.
- One database transaction per money movement.
- The ledger is append-only and corrected only by compensating transactions.
- The entries of each transaction sum to zero per currency.
- Customer balances never go below zero; system accounts may.
- System accounts keep no cached balance (theirs is the sum of their entries), so no movement ever updates their row or locks it (see Concurrency).

**Concurrency**

- READ COMMITTED with `SELECT ... FOR UPDATE` on customer accounts, one by one, in ascending id order.
- Never update a system account's row or take `FOR UPDATE`, `FOR NO KEY UPDATE` or `FOR SHARE` on it. The `FOR KEY SHARE` taken by the foreign key check is accepted (spec 002 section 1.3, LED-R14).
- Validate balances and status only after the locks are held.
- Retry the whole transaction on `40P01` and `40001` with bounded backoff and jitter.

**Idempotency**

- Every money-moving POST requires an `Idempotency-Key`, scoped per user and fingerprinted over method, path and canonical body.
- The key row is the first write of the movement's transaction.

**Security**

- Strict schemas for every input; authorization on every request; foreign resources answer 404.
- Never log secrets, tokens or credentials.
- Never read or print `.env`. When it needs new variables, run `npm run env:sync`.
- Parameterized SQL only, through Kysely or `pg` placeholders.

**TypeScript**

- `strict`, no `any`, no non-null assertion without a comment explaining why.
- Every promise awaited or explicitly handled (`no-floating-promises` is an error).
- Typed domain errors, mapped to `application/problem+json` (RFC 9457) at the HTTP edge.

## 4. Stack

Node 24 LTS, TypeScript 6 (strict), Fastify 5, Zod 4, PostgreSQL 16 with `pg` and Kysely, node-pg-migrate with SQL files, Redis 7 for rate limiting, `jose` for JWT, Vitest, ESLint and Prettier. Docker Compose locally, with nginx as the load balancer. Terraform for AWS.

## 5. Commands

| Command                               | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | From phase   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `npm run check`                       | Typecheck, lint, format check and unit tests. Must pass before any commit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 01-bootstrap |
| `npm run infra:up` / `infra:down`     | Start / stop local Postgres and Redis.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 01-bootstrap |
| `npm run infra:reset`                 | Delete the local volumes and start again, so changes in `docker/postgres/init` apply.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 01-bootstrap |
| `npm run test:integration`            | Integration tests against real Postgres and Redis.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 01-bootstrap |
| `npm run env:sync`                    | Adds variables missing from `.env`, taken from `.env.example`, without printing values.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 01-bootstrap |
| `npm run trace`                       | Lists every AC in `specs/` with its proof, read from the Vitest JSON reports in `reports/` written by `npm test` and `npm run test:integration`. Fails when an AC of an `Implemented` spec, or one named by a ticked task in `tasks.md`, has no passing test in the report of its level (level `ci`: a `Verified by` line that names no `npm run <script>`, or names one that is not a script in `package.json` or not the whole command, `npm run <script>` with plain arguments at most, of a step of `.github/workflows/ci.yml` that can fail the build) or is named by any test that did not pass; when a test or task names an undefined AC; when a project named in `--require` has no report; and when a spec or task file is malformed. CI and `/ship` pass `--require unit,integration`, so e2e ACs are enforced only from phase 12, when CI runs the e2e suite and requires its report. | 02-specs     |
| `npm run migrate:up` / `migrate:down` | Apply / roll back database migrations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 05-schema    |

## 6. Architecture and repository map

Hexagonal architecture (ports and adapters) per module, with tactical DDD, so money rules are unit-tested without infrastructure and the transaction boundary stays visible ([ADR-0003](docs/adr/0003-hexagonal-architecture-with-tactical-ddd.md)).

```
src/
  app.ts                      composition root
  modules/<module>/           accounts, ledger, movements, idempotency, auth
    domain/                   value objects, aggregates, domain errors
                              (never imports fastify, kysely, pg or ioredis)
    application/              use cases and the ports they need,
                              including the unit of work and row locking
    adapters/                 http routes, Kysely repositories
  platform/                   db and transactions, http error handling,
                              config, logging, metrics
specs/                        specs, plans and tasks
docs/adr/                     architecture decision records
docs/api/                     OpenAPI and API docs
docs/runbooks/                operational runbooks
docs/ai/                      AI usage log and transcripts
migrations/                   SQL migrations
test/unit, test/integration, test/e2e
test/support/                 shared test helpers: databases, row-lock sessions
infra/terraform/              AWS IaC (never applied from this repository)
```

## 7. Phases

Each phase is a separate session, named in transcripts and commits:

`00-setup`, `01-bootstrap`, `02-specs`, `03-adrs`, `04-plans`, `05-schema`, `06-domain`, `07-idempotency`, `08-api`, `09-hardening`, `10-runtime`, `11-e2e`, `12-infra`, `13-final-review`, `14-docs`, `15-demo`.

`specs/README.md` and `specs/000-overview/spec.md` are created in `02-specs`.

## 8. Git

- Each phase is developed on a branch named `phase/NN-name`, created from an up-to-date `main`.
- `/ship` commits and pushes that branch. When the phase closes, `/ship` opens a pull request to `main`, and the owner merges it with a merge commit once CI is green.
- Nothing is committed to `main` directly.
- Conventional Commits, with the covered AC IDs in the body.
- Commit and push only through the `/ship` skill or when the owner asks.
- Never push failing checks.
- Never force-push, rewrite pushed history, commit `.env` or skip hooks.

## 9. AI usage log

- Every session is exported to `docs/ai/transcripts/` and listed in `docs/ai/README.md`.
- Transcripts are never edited, except to replace a secret or token with `<redacted>`.

## 10. Definition of done

- `npm run check` and `npm run test:integration` are green.
- Every touched AC has a passing test with its ID in the name.
- Specs, ADRs, OpenAPI and README still match the code.
