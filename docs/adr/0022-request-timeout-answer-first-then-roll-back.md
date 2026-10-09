# ADR-0022: Request timeout: answer first, then roll back after the statement in flight

- **Status:** Accepted
- **Date:** 2026-10-08
- **Related specs:** 000-overview, 001-accounts, 003-money-movements, 004-reversals, 005-idempotency, 007-security-ops

## Context and problem

SEC-R33 bounds how long a request is handled: at `REQUEST_TIMEOUT_MS` the client must get 503 with `Retry-After: 1`, and the request's database work must not commit unless its `COMMIT` was already sent. ADR-0019 orders the layers so that the service answers before the load balancer gives up (SEC-R34). The question is what the service does with the statement still running on the request's pooled connection when the deadline is reached.

A first design cancelled that statement with `pg_cancel_backend` on the backend pid read inside the transaction, sent through the readiness connection. Three audit rounds on 2026-10-08 found that every variant of it had a way to fail: a pid read once per connection can belong to another client behind RDS Proxy, which moves client connections between backends between transactions (ADR-0019); a cancel that takes longer than its bound stays queued and can fire later, after the pid serves another request or is reused locally; the cancels share the readiness connection and delay readiness checks; and the extra states (transaction open without a pid, cancel pending, connection destroyed) multiply the cases to get right. Meanwhile `statement_timeout` (5 s on the runtime role, SEC-R29) already bounds every statement. The owner chose the simpler design below on 2026-10-08.

## Decision drivers

- The answer arrives at `REQUEST_TIMEOUT_MS`, never later, so the layer order of SEC-R34 holds.
- No action of the service can stop or change another request's statement.
- No transaction is left open on a pooled connection after the request ends.
- Few states, each of them testable with an injected clock.
- No `SET` and nothing that pins a connection behind RDS Proxy (SEC-R30).

## Considered options

### Option A: Answer at the deadline, start no further statement, roll back once the statement in flight ends

At the deadline the runner answers 503 and sends no further statement for the request. It awaits the statement in flight, whatever its outcome and at most until `statement_timeout` on the server, with a client-side limit a little above it (`statement_timeout` + 1000 ms) for a reply that never comes, such as after a network cut; when that limit fires, it releases the client with an error, so the pool destroys it. Otherwise it then sends `ROLLBACK` and releases the connection; a failed `ROLLBACK` or an unknown connection state releases the client with an error, so the pool destroys it. A `COMMIT` already sent finishes, the answer stays 503, and the outcome is unknown to the client, as for the load balancer's gateway errors (DEP-R16); a retry with the same `Idempotency-Key` gets the stored response.

- **Pros:**
  - Nothing is sent on any other connection, so no request can be affected by another's timeout, behind RDS Proxy or not.
  - The answer time is the deadline itself, whatever the database does.
  - The only states are: no transaction open, a statement in flight, a `COMMIT` in flight. Each is a unit test with an injected clock (SEC-AC25, SEC-AC38).
  - The readiness connection carries only readiness checks.
- **Cons:**
  - After the 503, the statement in flight keeps running, and keeps its locks and its pool connection, for up to `statement_timeout` (5 s); a burst of timeouts holds pool connections for that long.
  - A `COMMIT` already sent may succeed after the 503. A keyed request learns the result by retrying with the same key; a request without a key, such as an account creation without one (ACC-R04), cannot, as after any gateway error.
  - The shutdown coordinator must count these clean-ups as work in flight, and a clean-up cut off by `SHUTDOWN_TIMEOUT_MS` makes the process exit 1 (section 1.8 of spec 007).

### Option B: Answer at the deadline, then cancel the statement by its backend pid through the readiness connection

- **Pros:**
  - A timed-out statement stops at once and releases its locks and its connection sooner.
- **Cons:**
  - A cancel by pid can reach another request's statement: behind RDS Proxy the backend can serve another client once the transaction ends, and a cancel delayed past its bound fires after the pid is reused.
  - It needs the pid of every transaction, an extra round trip where it cannot share the first query, and states for a transaction whose pid is not known yet and for a cancel still pending.
  - Cancels compete with readiness checks on the one readiness connection, so a burst of timeouts can mark a healthy replica unready.

### Option C: Wait for the database before answering

- **Pros:**
  - The answer always matches what the database did.
- **Cons:**
  - The answer can come up to `statement_timeout` after the deadline, which with the default 25 s request timeout passes nginx's 30 s, so the load balancer answers 504 instead and SEC-R34 breaks.

### Option D: Destroy the client connection at the deadline

- **Pros:**
  - Simple, and frees the client side at once.
- **Cons:**
  - PostgreSQL notices a lost client only when it next writes to it, so a statement waiting on a lock keeps its locks until it ends, as with Option A, but the pool loses the connection and the transaction ends without a `ROLLBACK` the runner can observe.

## Decision

Chosen option: **Option A**, because it answers at the deadline and never sends anything that could stop another request's statement: a cancel by pid (Option B) can reach the wrong statement behind RDS Proxy or after the pid is reused, while `statement_timeout` already bounds every statement to 5 s. The service starts no further statement after the 503, rolls back once the statement in flight ends, and lets a `COMMIT` already sent finish, so its outcome is unknown to the client as after a gateway error, and a retry with the same `Idempotency-Key` gets the stored response (SEC-R33). Waiting for the database before answering (Option C) breaks the layer order; destroying the connection (Option D) frees nothing on the server sooner.

## Consequences

### Positive

- Every request is answered by the service at `REQUEST_TIMEOUT_MS` at the latest, never by the load balancer.
- No request can fail because of another request's timeout.
- The request runner has three cases, each unit-tested.

### Negative / costs

- A timed-out statement may hold its locks and pool connection for up to 5 s after the 503.
- A request whose `COMMIT` was already sent at the deadline has an outcome unknown to the client; without a key, a retry may repeat it.
- Shutdown waits for these clean-ups, and one cut off by `SHUTDOWN_TIMEOUT_MS` exits 1.

### To monitor

- 503 answers for the request timeout, by route.
- Pool usage (`scf_db_pool_connections`) and acquire timeouts after bursts of request timeouts.
- Shutdown exit codes: an exit 1 means a request or its clean-up was cut off.

### Follow-ups

- Phase 09-hardening: `src/platform/http/request-timeout.ts` and the shutdown coordinator's count of clean-ups, proven by SEC-AC25, SEC-AC38, SEC-AC21 and requirement-named tests of SEC-R27, SEC-R28 and SEC-R33 (plan 007).
  - Done in phase 09-hardening on 2026-10-08.
- Phase 12-infra: the runbook on timeouts and 503 answers explains the unknown outcome of a commit in flight and the retry with the same key.
  - Done in phase 12-infra on 2026-10-09: `docs/runbooks/timeouts-and-503.md`.
