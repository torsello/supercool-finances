# ADR-0010: Kysely and pg instead of an ORM

- **Status:** Accepted
- **Date:** 2026-10-08
- **Related specs:** 002-ledger, 003-money-movements, 004-reversals, 005-idempotency, 007-security-ops

## Context and problem

The money guarantees depend on exact control of the database: one transaction per movement with the key row as its first write (ADR-0009), a savepoint, `SELECT ... FOR UPDATE` on customer accounts in a fixed order (ADR-0008), a call to the lock-timeout function at precise points (SEC-R31), no `SET` statements (SEC-R30), `bigint` values that never pass through `number` (ADR-0006), and constraints and triggers that the database enforces on its own (section 1.3 of spec 002). The question is how the service talks to PostgreSQL and how the schema is defined.

## Decision drivers

- Explicit transactions and row locks, with every statement visible in the code.
- No hidden queries (lazy loading, cascades, implicit flushes) inside a movement.
- Type safety between the schema and the code.
- Parameterized SQL only (AGENTS.md section 3).
- `bigint` and `numeric` values kept exact.
- Constraints, triggers, roles and functions written and reviewed as SQL.

## Considered options

### Option A: Kysely over `pg`, with SQL-file migrations (node-pg-migrate)

- **Pros:**
  - A typed SQL builder: queries read like the SQL they produce, with column and result types checked against a database interface.
  - Row locks are first-class (`.forUpdate()`), so the lock query of MOV-R18 is explicit; raw fragments go through the `sql` template tag, still parameterized, for things like the lock-timeout function call.
  - No hidden queries: Kysely runs exactly the statements written, and a transaction is a connection the unit of work passes explicitly (ADR-0003).
  - `pg` returns `int8` and `numeric` as strings by default, so amounts reach the domain exact and are converted to `bigint` at the adapter.
  - Migrations are plain SQL files, so constraints, the deferred triggers, role grants and functions are reviewable as written and run identically locally, in CI and in AWS.
- **Cons:**
  - The database interface types must be kept in step with the migrations by hand (or generated), since the schema is not defined in TypeScript.
  - More SQL to write than with an ORM: no automatic relations or entity mapping.
  - Kysely is younger and less widely known than the big ORMs.

### Option B: Prisma

- **Pros:**
  - Generated, fully typed client; schema-first workflow with its own migrations; large community.
- **Cons:**
  - Hides transaction and locking semantics: there is no `FOR UPDATE` in its query API, so locks need raw SQL anyway, and interactive transactions have their own timeouts and behaviour to learn.
  - Its schema language does not express deferred constraint triggers or role grants; they would live in raw SQL beside it.
  - A separate query engine between the code and PostgreSQL.

### Option C: TypeORM

- **Pros:**
  - Familiar entity and repository model with decorators; supports locking modes.
- **Cons:**
  - Hides transaction and locking semantics behind entity managers, cascades and lazy relations, which can issue queries nobody wrote.
  - Weaker type safety on queries; decorators tie the domain model to persistence, against ADR-0003.

### Option D: Raw `pg` only

- **Pros:**
  - No abstraction at all; every statement is exactly what is written.
- **Cons:**
  - Loses type safety: query results are untyped rows and column names are unchecked strings.

## Decision

Chosen option: **Option A**, because money code needs explicit transactions and row locks. Kysely is a typed SQL builder with `forUpdate()` and no hidden queries, and migrations are plain SQL, so constraints and triggers are reviewable. Prisma and TypeORM hide transaction and locking semantics; raw `pg` alone loses type safety.

Kysely and `pg` live only in persistence adapters and `platform/` (ADR-0003). Lint enforces only the domain import rule today, which forbids them in `domain/`; elsewhere, review enforces it until the follow-up below. (Update 2026-10-08: phase 06-domain added these lint rules; see eslint.config.js.)

## Consequences

### Positive

- Every statement of a movement is visible in one place, in the order it runs.
- The database guarantees of spec 002 are SQL in `migrations/`, reviewed like code.
- Amounts are exact from the database to the domain.

### Negative / costs

- The Kysely database interface must match the migrations; a mismatch is a type lie that only integration tests catch.
- Mapping rows to aggregates is hand-written.

### To monitor

- Integration tests that exercise every repository against the migrated schema.
- Review for any `pg` type parser that turns `int8` or `numeric` into `number`.

### Follow-ups

- Phase 05-schema: first migrations and the Kysely database interface.
- Phase 06-domain and later: repositories and the unit of work on Kysely.
- Phase 06-domain: extend `no-restricted-imports` in `eslint.config.js` so that `src/modules/*/application/**` may not import `kysely`, `pg`, `fastify`, `ioredis` or any `adapters/` path, and no module imports another module's internals. Until then, review enforces it.
  - Done in phase 06-domain on 2026-10-08.
