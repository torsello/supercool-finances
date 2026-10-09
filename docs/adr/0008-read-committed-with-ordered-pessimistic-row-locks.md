# ADR-0008: Concurrency control with READ COMMITTED and ordered pessimistic row locks

- **Status:** Accepted
- **Date:** 2026-10-07
- **Related specs:** 000-overview, 001-accounts, 002-ledger, 003-money-movements, 004-reversals, 005-idempotency, 007-security-ops

## Context and problem

Several replicas run money movements, reversals and status changes concurrently on the same accounts (SYS-R16). The results must match some one-at-a-time execution of the movements accepted (SYS-R17): two withdrawals must never both pass a funds check that only one of them can satisfy (MOV-R22), crossed transfers must not deadlock into client errors (MOV-R23), and a status change and a movement on the same account must take effect one after the other (ACC-R17). Waits must be bounded so a request is always answered before the load balancer cuts it off (SYS-R35). The question is which isolation level and locking strategy guarantees this.

## Decision drivers

- Correctness under concurrency, with precedence over throughput (SYS-R17).
- No overdraft under any interleaving (MOV-R22, REV-R20).
- No deadlock or serialization error reaches the client in normal operation (MOV-R23).
- Throughput on hot accounts: few aborted and retried transactions.
- Bounded waits, answered as a retryable 503 rather than a timeout at the load balancer (SYS-R34, SYS-R35).
- System accounts never locked (LED-R14, ADR-0007).

## Considered options

### Option A: READ COMMITTED with ordered `SELECT ... FOR UPDATE` on customer accounts

- **Pros:**
  - Correct by construction: once a transaction holds the row locks on the accounts it debits and credits, no other movement can change those balances until it commits, so the funds check after locking is decisive.
  - Locking one by one in ascending `uuid` order (PostgreSQL's order of the `uuid` type, on the canonical lowercase form, MOV-R18, MOV-R30) gives every transaction the same global order, so crossed and circular transfers cannot deadlock (MOV-AC14, REV-AC23).
  - Contention makes transactions wait, not abort: on a hot account they queue instead of failing and retrying.
  - Explicit and testable: the lock plan is a pure function (MOV-AC15) and the order of checks puts status and funds after the locks (MOV-R17).
- **Cons:**
  - Correctness depends on discipline: every code path that reads a balance or status for a decision must lock first. A missed lock is a silent race, caught only by concurrency tests and review.
  - Throughput on one hot account is limited to one movement at a time.
  - Lock waits need explicit bounds and their own error mapping.

### Option B: SERIALIZABLE isolation

- **Pros:**
  - Also correct, and without relying on the code to lock the right rows: PostgreSQL detects conflicting interleavings.
- **Cons:**
  - Under contention on hot accounts it aborts many transactions with `40001`, each of which must be retried, so throughput falls and latency rises exactly where load is highest.
  - Predicate locking adds overhead to every transaction, and false positives abort transactions that did not actually conflict.

### Option C: Optimistic locking with a version column

- **Pros:**
  - No lock waits; works well when conflicts are rare.
- **Cons:**
  - The same retry problem as SERIALIZABLE: on a hot account most attempts lose the version race and retry.
  - Every write must check and bump the version, and a forgotten check is a lost update.

## Decision

Chosen option: **Option A**. Each movement locks the customer accounts it involves with `SELECT ... FOR UPDATE`, one by one in ascending `uuid` order, validates status and funds only after the locks are held, and never locks a system account: the lock query selects only accounts of kind customer (MOV-R18, REV-R18). The whole transaction is retried on deadlock (`40P01`) or serialization failure (`40001`) as a safety net, at most 3 attempts in total, waiting before retry n a random delay between 0 and min(200 ms, 10 ms × 2^(n−1)) (SYS-R18); if the last attempt fails, the answer is 503 with `Retry-After: 1` (SYS-R19). Each lock wait is bounded by a lock timeout that lasts only until the transaction ends, and a lock not acquired in time answers 503 with `Retry-After: 1` without retrying in process (MOV-R20, REV-R19, ACC-R29). SERIALIZABLE is also correct, but under contention on hot accounts it aborts and retries many transactions; optimistic locking with a version column has the same retry problem.

Details fixed by the specs:

- The account lock timeout is `ACCOUNT_LOCK_TIMEOUT_MS` (1 to 4999, default 2000, MOV-R31), below the runtime role's `statement_timeout` of 5 s, so a lock wait always ends as `55P03` and never as `57014`.
- It is set through a SQL function that calls `set_config('lock_timeout', <value>, true)`, transaction-local, because the service never sends `SET` statements that would pin a connection behind RDS Proxy (SEC-R30, SEC-R31).
- It is applied only after the idempotency record is written, immediately before the first account lock; the key row insert waits under its own `IDEMPOTENCY_WAIT_TIMEOUT_MS` and answers 409, never 503 (MOV-R19, MOV-R29, IDM-R11, IDM-R13).
- Status changes lock the account the same way and use the same timeout (ACC-R17, ACC-R28).
- The sum of every bounded wait over all retry attempts stays below the request timeout, which stays below the load balancer's (SYS-R35, SEC-R34, SEC-R35).

## Consequences

### Positive

- No overdraft and no lost update under any interleaving, proved by concurrency tests (MOV-AC13, REV-AC22, ACC-AC14).
- Crossed and circular transfers complete without deadlock errors (MOV-AC14, REV-AC23).
- Contention degrades to waiting, then to a bounded 503 that a client can retry safely with the same `Idempotency-Key` (MOV-R21).

### Negative / costs

- A hot account processes one movement at a time; its latency grows with its queue.
- Every new use case that decides on a balance or status must go through the lock port; this is enforced by design (ADR-0003) and review, not by the database.
- Timeouts form a budget across configuration variables that must be validated at startup (SEC-R35).

### To monitor

- Rate of 503 answers for lock timeouts and for exhausted retries; any `40P01` at all is a sign that a code path locks out of order.
- Lock wait time and p99 latency in the load test (SYS-R20).
- Concurrency tests in CI (MOV-AC13, MOV-AC14, REV-AC22, REV-AC23, ACC-AC14) for flakiness.

### Follow-ups

- Phase 05-schema: the lock-timeout SQL function of SEC-R31.
  - Done in phase 05-schema on 2026-10-08.
- Phase 06-domain: the lock plan as a pure function (MOV-AC15) and the transaction runner with retry (SYS-AC16).
  - Done in phase 06-domain on 2026-10-08; SYS-AC16 itself waits for `toProblem` in 08-api.
- Phase 07-idempotency and 08-api: the ordering of key row insert, lock timeout and account locks.
  - Done in phases 07-idempotency and 08-api on 2026-10-08; proven over HTTP by MOV-AC14 and MOV-AC19 in phase 09-hardening on 2026-10-08.
