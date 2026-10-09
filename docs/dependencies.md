# Dependencies

The approved dependencies: why each one is there and the phase that first uses it. A dependency is added to `package.json` in the phase that first uses it, so this list can name packages that are approved but not installed yet. The owner approved the initial set in the bootstrap prompt of phase `01-bootstrap`, and later additions on the dates noted beside them.

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
| `tsx`                    | Runs TypeScript directly: `npm run dev` and `npm run env:sync`.                                               | 01-bootstrap  |
| `vitest`                 | Unit and integration test runner.                                                                             | 01-bootstrap  |
| `@vitest/coverage-v8`    | Coverage for `npm run test:coverage`.                                                                         | 01-bootstrap  |
| `eslint`                 | Linter.                                                                                                       | 01-bootstrap  |
| `@eslint/js`             | ESLint recommended rules.                                                                                     | 01-bootstrap  |
| `typescript-eslint`      | Type-checked lint rules (`strictTypeChecked`, `no-floating-promises`).                                        | 01-bootstrap  |
| `eslint-config-prettier` | Turns off lint rules that conflict with Prettier.                                                             | 01-bootstrap  |
| `prettier`               | Formatter.                                                                                                    | 01-bootstrap  |
| `pino-pretty`            | Readable local logs.                                                                                          | 08-api        |
| `@redocly/cli`           | OpenAPI linting and bundling.                                                                                 | 08-api        |
| `yaml`                   | Parses `compose.yaml` in the deployment unit tests (plan 007 section 8). Approved by the owner on 2026-10-08. | 10-runtime    |
