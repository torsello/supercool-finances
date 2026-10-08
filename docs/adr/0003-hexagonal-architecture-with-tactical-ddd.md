# ADR-0003: Hexagonal architecture with tactical DDD inside each module

- **Status:** Accepted
- **Date:** 2026-10-07
- **Related specs:** 000-overview, 001-accounts, 002-ledger, 003-money-movements, 004-reversals, 005-idempotency, 007-security-ops

## Context and problem

ADR-0002 makes the service one deployable split into modules. Inside each module, the code must keep the money rules (balanced transactions, non-negative balances, the order of checks, reversal rules) testable without a database or HTTP server, while keeping the parts that make those rules safe under concurrency (the transaction boundary and the row locks) visible rather than hidden in a framework. The question is how to structure the code inside a module.

## Decision drivers

- Money rules are unit-tested fast and exhaustively, without infrastructure (for example LED-AC01, LED-AC02, LED-AC22, MOV-AC15, REV-AC03, SYS-AC16 are unit-level ACs).
- The transaction boundary and the locking order are explicit in the code, because the money guarantees depend on them (SYS-R11, MOV-R06, MOV-R18).
- The database still enforces the invariants as a second line of defence (LED-R03 to LED-R13, LED-R28).
- Infrastructure (Fastify, Kysely, `pg`) can change without touching business rules.
- No more machinery than the problem needs.

## Considered options

### Option A: Hexagonal architecture (ports and adapters) with tactical DDD

Each module has three layers, as in AGENTS.md section 6:

- **domain**: value objects such as `Money` and `Currency`, aggregates such as `Account` and `LedgerTransaction` that enforce their own invariants, and typed domain errors. It imports no framework or database code.
- **application**: the use cases and the ports they need, including the unit of work and row locking.
- **adapters**: HTTP routes (Fastify) and persistence (Kysely repositories).

- **Pros:**
  - Business rules run in unit tests with in-memory port implementations, so they are cheap to test at the limits (for example `bigint` arithmetic at the edge of the range, LED-AC22).
  - The unit of work and row locking are explicit ports (for example a lock port that takes customer account ids and locks them in ascending order, MOV-R18), not hidden behind a generic CRUD repository; reading a use case shows where the transaction starts, what is locked and when the checks run.
  - Aggregates enforce their invariants in one place (a `LedgerTransaction` cannot be built unbalanced, LED-R04, LED-R05), and the database enforces them again through constraints and a deferred trigger.
  - Typed domain errors map to problem details at the HTTP edge in one place (SYS-R24, SYS-R28).
  - Test seams attach at ports or as test-only Fastify plugins, all registered through the one list of SYS-R37, so they exist only in the test app.
  - A lint rule keeps the domain free of infrastructure: `eslint.config.js` forbids imports of `fastify`, `kysely`, `pg`, `ioredis` and other infrastructure packages, and of any `adapters/` or `platform/` path, from `src/modules/*/domain/**`.
- **Cons:**
  - More files and indirection than a direct route-to-SQL design: ports, adapters and mapping between rows and aggregates.
  - Mapping between database rows, domain objects and HTTP bodies is boilerplate.
  - Developers must know where each piece belongs; misplaced logic is a review finding, not a compile error.

### Option B: MVC (controllers, models, views)

- **Pros:**
  - Familiar and fast to start; fits user interfaces with pages and forms well.
- **Cons:**
  - In an API there are no views, and business rules tend to land in controllers or ORM models, mixed with HTTP and persistence.
  - Rules mixed with HTTP and SQL can only be tested through the database or the HTTP server.
  - Transaction boundaries and locks end up implicit in the ORM.

### Option C: Full DDD with event sourcing and CQRS

- **Pros:**
  - Strong auditing: every state change is an event, and history can be replayed.
  - Separate read models can be optimised per query.
- **Cons:**
  - Much more machinery: event store, projections, versioned events, eventual consistency between write and read models.
  - The double-entry ledger already gives an immutable, append-only history of every movement (ADR-0006), so the main benefit is already there at a fraction of the complexity.
  - Eventual consistency of read models conflicts with a response that returns the balance after the movement (section 1.2 of spec 003).

## Decision

Chosen option: **Option A**, because business rules are unit-tested without a database or HTTP server, a lint rule keeps the domain free of infrastructure imports, and the unit of work and row locking stay explicit ports instead of being hidden behind a generic CRUD repository, since the money guarantees depend on them. The database still enforces the invariants as a second line of defence. MVC fits user interfaces, but in an API it tends to put business rules in controllers or ORM models, mixed with HTTP and persistence. Full DDD with event sourcing and CQRS is strong for auditing, but the double-entry ledger already gives an immutable history at a fraction of the complexity.

Reads such as an account's history (ACC-R21, ACC-R22) or a transaction by id (MOV-R26, MOV-R27) go through simple query services in the application layer that bypass the aggregates and read through a query port, since they enforce no invariant and only need the right projection, paging and authorization.

## Consequences

### Positive

- The order of checks of section 1.4 of spec 003 and section 1.4 of spec 004 is code in one use case, unit-testable step by step.
- Swapping or upgrading Fastify or Kysely touches adapters only.
- Domain rejections and database rejections are distinct. The persistence adapter translates the constraint violations the specs name into typed domain rejections: the unique violation of REV-R05 becomes `already-reversed`, answers 409 and is stored for replay (REV-R06, IDM-R14). A rejection by one of the ledger checks of spec 002 means the domain missed a rule and answers 500 (LED-R28), and so does any other constraint or trigger violation. Lock timeouts, statement timeouts, deadlocks and serialization failures are not rejections of this kind: they are answered as SYS-R18, SYS-R34, SEC-R32 and IDM-R13 say.

### Negative / costs

- More files per feature; reviewers must check that logic sits in the right layer.
- Row-to-aggregate mapping must be kept exact for `bigint` amounts (never through `number`).

### To monitor

- `npm run lint`: the domain import rule must stay an error and keep its package list current as dependencies are added.
- Review and `/audit` findings of business rules in routes or repositories, or of SQL issued outside the unit of work.

### Follow-ups

- Phase 04-plans names the ports of each module (unit of work, account lock, repositories, query services, clock, id generator).
- Phase 06-domain implements the value objects and aggregates with unit tests first.
