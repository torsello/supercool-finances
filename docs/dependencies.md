# Dependencies

The approved dependencies: why each one is there and the phase that first uses it. A dependency is added to `package.json` in the phase that first uses it; every package below is installed. The owner approved the initial set in the bootstrap prompt of phase `01-bootstrap`, and later additions on the dates noted beside them.

A new dependency needs an ADR or the owner's approval recorded here (AGENTS.md §2). Versions live in `package.json` and `package-lock.json`, not here.

## Runtime

| Package                     | Purpose                                                                                                                                                                                                                       | First used in                         |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `fastify`                   | HTTP server.                                                                                                                                                                                                                  | 01-bootstrap                          |
| `fastify-type-provider-zod` | Zod schemas for Fastify request validation, response serialization and OpenAPI.                                                                                                                                               | 01-bootstrap                          |
| `zod`                       | Strict input and output schemas.                                                                                                                                                                                              | 01-bootstrap                          |
| `pg`                        | PostgreSQL driver; returns `bigint` as exact strings.                                                                                                                                                                         | 01-bootstrap (integration smoke test) |
| `ioredis`                   | Redis client for rate limiting.                                                                                                                                                                                               | 01-bootstrap (integration smoke test) |
| `kysely`                    | Type-safe SQL query builder over `pg`, parameterized only.                                                                                                                                                                    | 05-schema                             |
| `node-pg-migrate`           | SQL-file database migrations.                                                                                                                                                                                                 | 05-schema                             |
| `uuid`                      | UUIDv7 ids: time-ordered, so primary key indexes stay compact. `crypto.randomUUID` only produces v4.                                                                                                                          | 06-domain                             |
| `jose`                      | JWT verification.                                                                                                                                                                                                             | 08-api                                |
| `@fastify/swagger`          | OpenAPI document generated from the route schemas.                                                                                                                                                                            | 08-api                                |
| `@fastify/swagger-ui`       | Interactive API docs.                                                                                                                                                                                                         | 08-api                                |
| `@fastify/cors`             | CORS for the exact origins in `CORS_ORIGINS`, off when it is empty (SEC-R16, SEC-R17). Approved by the owner on 2026-10-07.                                                                                                   | 09-hardening                          |
| `@fastify/helmet`           | Security headers.                                                                                                                                                                                                             | 09-hardening                          |
| `@fastify/rate-limit`       | Rate limiting. Must use the Redis store (spec 007): in-process counters are forbidden with several replicas.                                                                                                                  | 09-hardening                          |
| `close-with-grace`          | Runs the ordered shutdown on an uncaught exception or unhandled rejection, then exits 1. It skips every signal, since it exits at once on a second one: `src/main.ts` handles SIGTERM and SIGINT itself (plan 007 section 4). | 09-hardening                          |
| `@prometheus-io/client`     | Prometheus metrics (`prom-client` is deprecated).                                                                                                                                                                             | 09-hardening                          |

## Development

| Package                  | Purpose                                                                                                       | First used in |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------- |
| `typescript`             | Compiler and type checker (strict).                                                                           | 01-bootstrap  |
| `@types/node`            | Node 24 type definitions.                                                                                     | 01-bootstrap  |
| `@types/pg`              | `pg` type definitions.                                                                                        | 01-bootstrap  |
| `tsx`                    | Runs TypeScript directly: `npm run dev` and every script under `scripts/` and `src/cli/`.                     | 01-bootstrap  |
| `vitest`                 | Unit, integration and e2e test runner.                                                                        | 01-bootstrap  |
| `@vitest/coverage-v8`    | Coverage for `npm run test:coverage`.                                                                         | 01-bootstrap  |
| `eslint`                 | Linter.                                                                                                       | 01-bootstrap  |
| `@eslint/js`             | ESLint recommended rules.                                                                                     | 01-bootstrap  |
| `typescript-eslint`      | Type-checked lint rules (`strictTypeChecked`, `no-floating-promises`).                                        | 01-bootstrap  |
| `eslint-config-prettier` | Turns off lint rules that conflict with Prettier.                                                             | 01-bootstrap  |
| `prettier`               | Formatter.                                                                                                    | 01-bootstrap  |
| `@redocly/cli`           | OpenAPI linting (`npm run openapi:lint`).                                                                     | 08-api        |
| `yaml`                   | Parses `compose.yaml` in the deployment unit tests (plan 007 section 8). Approved by the owner on 2026-10-08. | 10-runtime    |

## CI tools

Tools CI runs outside `package.json`, each pinned by version and digest or checksum. Terraform, tflint and checkov run through `npm run infra:validate` (ADR-0015), gitleaks in the job `secret-scan` (spec 008, DEP-R36), the Mermaid CLI through `npm run docs:check` (DEP-R47), and newman through the e2e suite (DEP-R49). Terraform, tflint, checkov and gitleaks are covered by ADR-0015 and spec 008 and are not repeated below.

| Tool          | Purpose                                                                                                                                                                                                                                                                                                      | First used in |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| `trivy`       | The job `security` of `.github/workflows/ci.yml`: `trivy fs`, `trivy config` and `trivy image` of the runtime stage, failing on HIGH and CRITICAL, from the `aquasec/trivy` image pinned by version and digest. Approved by the owner on 2026-10-09 (plan 000 section 11).                                   | 12-infra      |
| `mermaid-cli` | `npm run docs:check` and the job `docs` of `.github/workflows/ci.yml`: renders every `mermaid` block of the Markdown files tracked by git, from the `minlag/mermaid-cli` image pinned by version and digest, fed on standard input (section 1.10 of spec 008, DEP-R47). Approved by the owner on 2026-10-09. | 14-docs       |
| `newman`      | Runs the Postman collection of `docs/api/postman/` in the e2e test of DEP-AC38, through `npx --yes newman@6.2.3`, an exact version, so nothing is added to `package.json` (section 1.11 of spec 008, DEP-R49). Approved by the owner on 2026-10-09.                                                          | 14-docs       |

## Container images

Images the repository runs besides PostgreSQL, Redis, nginx and the Node base image, each pinned by version and digest (DEP-R22) and updated by Dependabot. Terraform, tflint and checkov run from images pinned in `scripts/infra-validate.sh` (ADR-0015), and trivy and the Mermaid CLI are listed under CI tools.

| Image             | Purpose                                                                                                                                                                      | First used in     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `prom/prometheus` | Scrapes the replicas' metrics inside the compose network, in the Compose profile `observability` only (spec 008 section 1.9, ADR-0023). Approved by the owner on 2026-10-09. | 12b-observability |
| `grafana/grafana` | The read-only dashboard over those metrics on `127.0.0.1:3030`, in the profile `observability` only (spec 008 section 1.9, ADR-0023). Approved by the owner on 2026-10-09.   | 12b-observability |

Error reporting (spec 007 section 1.10) adds no package: the owner chose on 2026-10-09 the service's own envelope client on Node's `fetch` over `@sentry/node` (ADR-0023).
