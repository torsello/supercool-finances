# ADR-0005: PostgreSQL as the only source of truth

- **Status:** Accepted
- **Date:** 2026-10-07
- **Related specs:** 000-overview, 001-accounts, 002-ledger, 004-reversals, 005-idempotency, 006-auth, 007-security-ops, 008-deployment

## Context and problem

The challenge (docs/challenge.md) allows in-memory storage. This service, however, runs as several replicas behind a load balancer (SYS-R16, DEP-R15, DEP-R27) and must not lose or duplicate money when a replica crashes or is killed mid-request (DEP-R17). Locks, idempotency records, balances and the ledger must therefore be shared by every replica and survive restarts. The question is where that state lives.

## Decision drivers

- Shared state across replicas: any replica gives the same result for the same request (SYS-R16).
- Durability and atomicity: a movement commits entirely or not at all, also on a crash (SYS-R11, DEP-R17).
- Row-level locking for concurrent movements on the same accounts (ADR-0008).
- The database itself enforces the money invariants, so a code defect cannot commit a broken ledger (LED-R03 to LED-R17).
- Money correctness must not depend on any secondary store.
- Available as a managed, Multi-AZ service in AWS (DEP-R29).

## Considered options

### Option A: PostgreSQL, with Redis only for rate-limit counters

- **Pros:**
  - ACID transactions: a movement's idempotency record, locks, ledger entries, balance changes and audit record commit together (SYS-R11).
  - Row locks (`SELECT ... FOR UPDATE`) and `lock_timeout` for the concurrency model of ADR-0008.
  - The database enforces invariants independently of the code: CHECK constraints (non-zero amounts, `balance >= 0` on customer accounts, no cached balance on system accounts, LED-R03, LED-R12, LED-R13), unique indexes (one reversal per transaction, REV-R05; one key row per user and key, spec 005) and deferrable constraint triggers that check at commit that each transaction balances, has two or more entries and one currency (LED-R04 to LED-R07), and that no key row is committed without a result (IDM-R18).
  - Privileges and triggers both make the ledger append-only: privileges stop the runtime role, and the triggers also stop the owner role (LED-R16, LED-R17).
  - `numeric` gives arbitrary-precision sums for system balances and reconciliation (LED-R15), and REPEATABLE READ gives the reconciliation one consistent snapshot without locks (LED-R20).
  - Idempotency keys live in the same transaction as the movement, so a key and its effects can never disagree (IDM-R06).
  - Mature managed offering (RDS Multi-AZ with RDS Proxy, DEP-R29).
- **Cons:**
  - One database is the write bottleneck and a single point of failure without Multi-AZ.
  - Every request needs a connection; pool sizing must fit `max_connections` across replicas (SEC-R36).
  - Schema changes need migrations and care with locks on large tables.
  - Two stores to run (PostgreSQL and Redis), although only one matters for correctness.

### Option B: In-memory storage

- **Pros:**
  - Allowed by the challenge; no infrastructure, fastest to build and test.
- **Cons:**
  - Lost on restart.
  - Not shared between replicas: two replicas would hold two different ledgers, and locks or idempotency in one process protect nothing in another.

### Option C: SQLite

- **Pros:**
  - ACID and SQL with no server to run.
- **Cons:**
  - A single writer, and no network access: replicas on different hosts cannot share one file safely.
  - No row-level locks or roles; fewer ways to enforce invariants in the database.

## Decision

Chosen option: **Option A**, because several replicas behind a load balancer and crash safety require shared, durable state, and PostgreSQL gives ACID transactions, row locks, check constraints, unique indexes and deferrable constraint triggers, so the database itself enforces the invariants. Redis holds only the per-user rate-limit counters (SEC-R04, SEC-R07), so money correctness never depends on it: when Redis is down, requests are served as if under the limit and money stays correct (SEC-R06, SEC-AC06). SQLite has a single writer and no network access; in-memory state is lost on restart and not shared between replicas.

The service keeps no state in process memory that affects a result: no locks, idempotency, sessions, token caches or rate-limit counters (SYS-R16, AUT-R21). Cursors are signed with a shared secret so any replica accepts them (ACC-R30).

## Consequences

### Positive

- Any replica can serve any request; replicas can be added, removed or killed without losing money (DEP-AC11).
- A defect in the domain is stopped by the database and surfaces as a 500 with nothing applied (LED-R28), instead of a corrupt ledger.
- Reconciliation is a SQL query over one snapshot (LED-R19, LED-R20).

### Negative / costs

- Throughput is bounded by one PostgreSQL primary and by row-lock contention on hot accounts.
- Connection pool sizing, statement and lock timeouts must be managed explicitly (spec 007, sections 1.1 and 1.9).
- Tests that prove database guarantees must run against a real PostgreSQL (integration level), which is slower than unit tests.

### To monitor

- Database connections, CPU and lock waits; pool acquire timeouts (SEC-R36, SEC-AC27).
- The reconciliation after every CI run (LED-R22) and on demand: any discrepancy or non-zero global sum.
- `scf_rate_limit_store_errors_total`: Redis being down affects rate limiting only.

### Follow-ups

- Phase 05-schema writes the migrations: two roles (owner and runtime), constraints, triggers and privileges of section 1.3 of spec 002.
- ADR-0006, ADR-0007 and ADR-0008 define the ledger model, system accounts and concurrency control on top of this decision.
