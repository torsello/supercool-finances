# ADR-0009: Idempotency inside the movement's transaction

- **Status:** Accepted
- **Date:** 2026-10-08
- **Related specs:** 000-overview, 001-accounts, 003-money-movements, 004-reversals, 005-idempotency, 007-security-ops, 008-deployment

## Context and problem

Clients retry: a timeout, a dropped connection or a crashed replica leaves them not knowing whether money moved. Every money-moving POST therefore carries an `Idempotency-Key`, and a retry with the same key must get the first answer instead of moving money again (section 1 of spec 005). Several replicas serve requests (SYS-R16), so two copies of the same request can run at the same time on different replicas, and a replica can die between applying a movement and answering it (DEP-R17, IDM-R19). The question is where the key and its stored response live, and how a key's state stays consistent with the movement it protects.

## Decision drivers

- At most one execution per user and key, on any replica, under concurrency and crashes (IDM-R10, DEP-R17).
- A key and its effect can never disagree: no key that says "done" without its movement, and no movement without its key.
- No recovery job for keys left behind by a crash.
- A replay returns the original answer even after configuration, account state or code version changed (IDM-R08).
- Money correctness never depends on Redis (SEC-R07) or on process memory (SYS-R16).

## Considered options

### Option A: The key row is the first write of the movement's own database transaction

The transaction begins, sets `lock_timeout` to `IDEMPOTENCY_WAIT_TIMEOUT_MS`, inserts the key row for (user, key) with the request's fingerprint, takes a savepoint, and only then validates, locks accounts and applies the movement; the response is written into the key row before commit (section 1.1 of spec 005).

- **Pros:**
  - The key and its effect commit or roll back together: a crash before commit leaves neither, a commit leaves both. There are no stuck "in progress" keys and no recovery job.
  - Concurrent duplicates serialize on PostgreSQL's row lock for the key: the second insert waits for the first transaction, then reads the stored response (IDM-R07), gets 422 for a different fingerprint (IDM-R09), or runs as a first request if the first rolled back (IDM-R10). This works across replicas with no extra coordination.
  - The savepoint after the key insert lets a rejection at the lookup step or by a business rule roll back its partial effects and still store and commit its response (IDM-R14), so a retry of an insufficient-funds transfer replays the 422 instead of succeeding after the funds arrive (IDM-AC15).
  - A deferred constraint trigger refuses to commit a key row without a stored response (IDM-R18), so a defect fails loudly instead of leaving a key that blocks retries.
  - A replay is answered right after the malformed-request step, before validation and every later check (SYS-R33, IDM-R08), so a configuration change (for example a lower `MAX_AMOUNT_MINOR`) or a newer version never turns an applied movement into an error.
- **Cons:**
  - A duplicate that arrives while the first request runs waits on the key row, holding a pool connection and an open transaction; the wait is bounded by `IDEMPOTENCY_WAIT_TIMEOUT_MS` (default 2000 ms) and then answers 409 `/problems/request-in-progress` (IDM-R12). This is the main cost.
  - Every keyed request, a replay included, runs in a database transaction that attempts the key insert.
  - It only works because every effect of a movement is in the same PostgreSQL database; it cannot cover a call to an external system.
  - Validation runs after a write, so the framework's validation never answers before the replay step (ADR-0004).

### Option B: Two-phase keys (claim the key and commit, execute, then complete the key)

- **Pros:**
  - Works when the operation calls external systems (a payment rail, another service) that cannot join the database transaction.
  - Duplicates see "in progress" immediately instead of waiting on a lock.
- **Cons:**
  - A crash between claim and completion leaves a key in progress that must be recovered: a timeout, a sweeper job and rules for whether the operation ran.
  - Two or three transactions per request instead of one, with states in between to reason about.
  - Unnecessary here: the service calls no external system.

### Option C: Keys in Redis

- **Pros:**
  - Fast lookups and native expiry with a TTL.
- **Cons:**
  - Money correctness would depend on Redis, which SEC-R07 forbids; a Redis failover or eviction could lose keys and let a retry move money twice.
  - Cannot commit atomically with the ledger: there is always a window where the key and the movement disagree.

### Option D: A stored status with client polling

- **Pros:**
  - Duplicates never wait; clients poll a status endpoint.
- **Cons:**
  - Adds a state machine for each key (received, in progress, done, failed) and recovery for keys left in progress by a crash, as in Option B.
  - Adds an endpoint and a polling protocol to every client.

### Option E: Keys in process memory

- **Pros:**
  - Simplest and fastest.
- **Cons:**
  - Not shared between replicas and lost on restart, so it protects nothing in this deployment (SYS-R16).

## Decision

Chosen option: **Option A**, because with the key row as the first write of the same transaction, the key and its effect commit or roll back together: no stuck "in progress" keys and no recovery job. Concurrent duplicates wait on the key row and then read the stored response; the wait is bounded and holds a pool connection, which is the main cost. A savepoint after the key insert lets a business rejection be stored and committed without its effects. A replay is answered before validation, so a configuration change or a newer version never turns an applied movement into an error. Keys expire after 24 hours and an hourly job deletes them.

A two-phase design (claim the key, commit, execute, complete) is needed when calling external systems that cannot join the transaction; the service has none, so it is the documented evolution path. A Redis store would make money correctness depend on Redis (SEC-R07) and cannot commit atomically with the ledger. A stored status with client polling adds a state machine and recovery for keys left in progress. In-process memory is not shared between replicas.

Details fixed by spec 005 that this ADR follows:

- Keys are scoped per user (the token's `sub`) and compared exactly; one user's key space covers every endpoint that takes a key (IDM-R04). Account creation takes an optional key (IDM-R02).
- The fingerprint is the SHA-256 of the method, the path as received without the query string, and the body in the JSON Canonicalization Scheme of RFC 8785 (IDM-R05).
- What is stored: a 201, a 404 at lookup and every business rejection are stored; validation errors, key errors, 5xx and everything before the key step are not (section 1.3 of spec 005, IDM-R14 to IDM-R17).
- The retry of SYS-R18 re-runs the whole transaction, key insert included (IDM-R17).
- The key wait and the account lock wait are separate: 409 for the key, 503 for an account (IDM-R11 to IDM-R13, ADR-0008).
- `IDEMPOTENCY_KEY_TTL_SECONDS` defaults to 86400 (24 h), counted from the row's creation; an insert replaces an expired row (IDM-R20, IDM-R21). `npm run idempotency:cleanup` deletes expired rows in batches of 1000 with `FOR UPDATE SKIP LOCKED`, never runs inside the service, and runs every hour in AWS as a scheduled ECS task (IDM-R22, DEP-R37).

## Consequences

### Positive

- A movement is applied at most once per user and key while the key lives, across replicas, retries and crashes (IDM-AC10, IDM-AC21, DEP-AC11).
- No sweeper or recovery job for keys; the only background work is deleting expired rows, which never touches a request in progress.
- A client can always retry with the same key on a 5xx, a 409 `request-in-progress` or a connection error, and get one consistent result (section 1.5 of spec 008).

### Negative / costs

- Duplicates in flight hold pool connections while they wait; a client that hammers one key can consume connections for up to the wait timeout each, bounded by the per-user rate limit (spec 007).
- The key table grows with traffic for a day before cleanup.
- A request retried after its key expired runs again; the API documentation states the TTL (section 1.4 of spec 005).
- A future call to an external system needs a new ADR moving to Option B.

### To monitor

- `scf_lock_timeouts_total{lock="idempotency"}` (409 answers) and `scf_idempotent_replays_total`.
- Pool usage (`scf_db_pool_connections`) during bursts of duplicate requests.
- Size of the key table and the `deleted` count of each cleanup run.

### Follow-ups

- Phase 05-schema: the key table, its primary key (user, key) and the deferred trigger of IDM-R18.
- Phase 07-idempotency: the key step, fingerprint, savepoint and stored responses.
- Phase 12-infra: the hourly cleanup schedule (DEP-R37).
