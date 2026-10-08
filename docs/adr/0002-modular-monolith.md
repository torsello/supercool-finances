# ADR-0002: Modular monolith

- **Status:** Accepted
- **Date:** 2026-10-07
- **Related specs:** 000-overview, 002-ledger, 003-money-movements, 004-reversals, 005-idempotency, 008-deployment

## Context and problem

The service has one bounded context: customer balances. Its central operations cross what could look like service boundaries: a transfer debits one account and credits another, writes a balanced ledger transaction, an idempotency record and an audit record, and all of it must commit together or not at all (SYS-R11, MOV-R06, REV-R17). The service must still run as several replicas behind a load balancer (SYS-R16, DEP-R15). The question is how to split the code into deployable units.

## Decision drivers

- One movement is one atomic unit across accounts, ledger, idempotency and audit (SYS-R11).
- Horizontal scaling with several stateless replicas (SYS-R16, DEP-R27).
- Few failure modes: no partial movements, no distributed recovery logic.
- Clear internal boundaries, so the code stays understandable and a module could be extracted later.
- A small team and a short time box.

## Considered options

### Option A: Modular monolith

One deployable with internal modules: `accounts`, `ledger`, `movements`, `idempotency` and `auth` under `src/modules/`, plus the HTTP edge and `platform` (database and transactions, error handling, configuration, logging, metrics), as in AGENTS.md section 6.

- **Pros:**
  - A movement is one PostgreSQL transaction: ACID across accounts, ledger, idempotency and audit with no saga, outbox or two-phase commit.
  - Scales horizontally as identical stateless replicas; all shared state is in PostgreSQL (ADR-0005).
  - One build, one image, one deployment and one set of logs and metrics to operate.
  - In-process calls between modules: no network latency or partial failure between them.
  - Explicit module interfaces (ports, ADR-0003) keep the boundaries visible, so a module could be extracted later.
- **Cons:**
  - Modules cannot be deployed or scaled independently; a change to any module redeploys all of them.
  - Boundaries are enforced by convention, review and lint, not by the network, so they can erode if not reviewed. Lint enforces only the domain import rule today (`src/modules/*/domain/**` may not import infrastructure, `adapters/` or `platform/`); imports between modules are enforced by review. (Update 2026-10-08: phase 06-domain added these lint rules; see eslint.config.js.)
  - All modules share one database, which is a single scaling point for writes.

### Option B: Microservices (for example accounts, ledger and movements as separate services)

- **Pros:**
  - Independent deploys, scaling and technology choices per service.
  - Hard boundaries enforced by the network and separate data stores.
- **Cons:**
  - Splits one consistency boundary: a transfer would span services and need a saga or distributed transaction, with compensations for every partial failure.
  - Adds network failure modes (timeouts, retries, duplicate delivery) to every movement, each needing its own idempotency.
  - Much more infrastructure and operational work (service discovery, per-service pipelines, tracing) with no benefit at this size.

### Option C: Unstructured monolith

- **Pros:**
  - Least ceremony to start.
- **Cons:**
  - No boundaries: money rules, HTTP and SQL mix, the domain cannot be unit-tested in isolation, and nothing could be extracted later.

## Decision

Chosen option: **Option A**, because there is one bounded context in which a transfer must update two accounts atomically, and one deployable with internal modules gives ACID transactions without sagas or distributed transactions while still scaling horizontally as stateless replicas. Microservices would give independent deploys and scaling, but would split one consistency boundary and add network failure modes for no benefit at this size. Modules have explicit interfaces, so one could be extracted later.

## Consequences

### Positive

- The guarantees of SYS-R11, MOV-R06 and REV-R17 (everything of a movement commits together) follow from a single database transaction.
- Two or more identical replicas behind nginx locally and the ALB in AWS (spec 008), with no coordination between them beyond PostgreSQL.
- Every test level (unit, integration, e2e) runs against one process or one stack.

### Negative / costs

- Every release ships every module.
- Module boundaries need discipline: a module uses another only through its application-layer interface, never its tables or adapters.
- Database write capacity bounds the whole service.

### To monitor

- Imports across module internals in review and `/audit` (a module reaching into another's `adapters/` or `domain/` internals).
- Database CPU, connections and lock waits under the load test (SYS-R20): the first sign that one database is the limit.

### Follow-ups

- ADR-0003 defines the layers inside each module.
- Phase 06-domain: extend `no-restricted-imports` in `eslint.config.js` so that `src/modules/*/application/**` may not import `kysely`, `pg`, `fastify`, `ioredis` or any `adapters/` path, and no module imports another module's internals. Until then, review enforces it.
  - Done in phase 06-domain on 2026-10-08.
- If a module ever needs to be split out, a new ADR must first address how its writes stay atomic with the ledger.
