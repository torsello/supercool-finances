# ADR-0019: Timeout layers and RDS Proxy

- **Status:** Accepted
- **Date:** 2026-10-08
- **Related specs:** 000-overview, 001-accounts, 003-money-movements, 004-reversals, 005-idempotency, 007-security-ops, 008-deployment

## Context and problem

A request passes through the load balancer, a service replica, the connection pool and PostgreSQL, and can wait at each: for a key row, for account locks, for a statement, for a connection. If an outer layer gives up first, the client gets a gateway error with no explanation while the inner work may still commit. In AWS, connections go through RDS Proxy, which multiplexes client connections over database connections between transactions, but pins a client connection to one database connection when it detects session state, losing the benefit of the proxy. The lock timeouts change within a transaction (one for the key wait, another for the account locks, ADR-0008, ADR-0009). The question is how timeouts are layered and how they are set without pinning.

## Decision drivers

- Every request is answered by the innermost layer that knows why it failed (SYS-R35).
- Lock waits end as `55P03` (answered 409 or 503), never as a statement cancellation (SEC-R34).
- No session state leaks to another request on a pooled connection.
- No pinning behind RDS Proxy (SEC-R30).
- An invalid timeout configuration never starts.

## Considered options

### Option A: Ordered layers, timeouts on the role, lock timeouts through a transaction-local SQL function

- **Pros:**
  - Each layer gives up before the layer outside it: lock waits < statement timeout < request timeout < load balancer (section 1.1 of spec 007), and the service refuses to start with a configuration that breaks that budget (SEC-R35).
  - `statement_timeout` and `idle_in_transaction_session_timeout` are set on the runtime role with `ALTER ROLE ... SET` from a migration (SEC-R29), so every session starts with them and the service sends no `SET`.
  - The lock timeouts go through a small SQL function, `app.set_lock_timeout(ms)`, that calls `set_config('lock_timeout', ..., true)` (SEC-R31): the value is transaction-local, so it ends with the transaction and never reaches another request.
  - According to AWS, calling a stored function does not pin (see Decision).
- **Cons:**
  - Relies on documented RDS Proxy behaviour that AWS can change, and on the proxy not detecting state changes inside functions.
  - A custom SQL function to own, grant and test.
  - Timeouts are spread over role settings, service configuration and load balancer configuration, so the budget must be checked across all three.

### Option B: Per-connection or per-transaction `SET` statements from the service

- **Pros:**
  - Simplest: `SET lock_timeout = ...` or `SET LOCAL lock_timeout = ...` where needed, and session settings on connect.
- **Cons:**
  - RDS Proxy pins any connection that runs `SET` (or a direct `set_config`), so under load every connection becomes pinned and the proxy stops multiplexing.

### Option C: Session defaults in RDS Proxy's initialization query

- **Pros:**
  - Applied by the proxy without pinning.
- **Cons:**
  - One fixed value per connection: cannot switch the lock timeout between the key wait and the account locks within one transaction.
  - Exists only in AWS, so local and CI behaviour would differ.

## Decision

Chosen option: **Option A**. Each layer gives up before the layer outside it (lock waits < statement timeout < request timeout < load balancer), and the service refuses to start with a configuration that breaks that budget. Database timeouts are set on the runtime role; the per-transaction lock timeouts go through a small SQL function that calls `set_config(..., true)`, so they last only until the transaction ends and RDS Proxy does not pin the connection. Per-connection `SET` statements are simpler but pin connections behind RDS Proxy.

**Source.** The AWS page "Avoiding pinning an RDS Proxy" (<https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-pinning.html>, read on 2026-10-08) lists, among the conditions that cause pinning for RDS for PostgreSQL, "Using `SET` commands" and "Setting a parameter, or resetting a parameter to its default. Specifically, using `SET` and `set_config` commands to assign default values to session variables". It also says that "Calling stored procedures and stored functions doesn't cause pinning. RDS Proxy doesn't detect any session state changes resulting from such calls." The function's setting is transaction-local, so no state survives the transaction, which is the condition AWS gives for relying on this.

Values fixed by spec 007 (section 1.1): account lock 2000 ms and key wait 2000 ms, each 1 to 4999 ms (MOV-R31, IDM-R23); `statement_timeout` 5 s and `idle_in_transaction_session_timeout` 10 s; pool acquire 2000 ms; Redis command 100 ms; request timeout 25000 ms, above the worst-case sum of 20130 ms; nginx 30 s and ALB 60 s; service keep-alive 65 s above the load balancer's 60 s (SEC-R34). The function is `SECURITY INVOKER`, accepts 1 to 60000 ms and is executable only by the runtime role (section 1.9 of spec 007). A statement cancelled by `statement_timeout` and a request past its timeout answer 503 and are not retried in process (SEC-R32, SEC-R33).

## Consequences

### Positive

- Every timeout produces a specific, retryable answer from the service, not a gateway error.
- No session state crosses requests on a pooled connection, locally or behind RDS Proxy.
- A misconfigured deployment fails at startup, naming the variables (SEC-R35, SEC-R40).

### Negative / costs

- The rule "never send `SET`, `RESET`, `DISCARD` or a direct `set_config`" (SEC-R30) binds every future feature; the same AWS page lists other PostgreSQL pinning conditions to avoid too: named `PREPARE` statements, temporary tables, cursors, `LISTEN`, session advisory locks, and sequence functions such as `nextval` (ids are UUIDv7 generated by the service, so no sequence is needed); and, for every engine, any statement whose text is larger than 16 KB, such as a large multi-row `INSERT` or `IN` list. `DatabaseConnectionsCurrentlySessionPinned` watches all of them.
- If AWS changes the proxy so that it detects state changes inside functions, connections pin silently.

### To monitor

- `DatabaseConnectionsCurrentlySessionPinned` on RDS Proxy: its Maximum should stay at 0.
- `scf_lock_timeouts_total`, 503 rates and p99 latency against the request timeout.

### Follow-ups

- Phase 05-schema: the role settings migration and `app.set_lock_timeout`.
- Phase 12-infra: re-check the AWS page; if the documented behaviour changed, write a new ADR. Decide whether the migration task connects through RDS Proxy or to the instance directly (node-pg-migrate's session advisory lock pins its connection through the proxy), and whether to alarm on `DatabaseConnectionsCurrentlySessionPinned`; either one is a change to spec 008 for its owner to approve.
  - (Update 2026-10-09, phase 12-infra.) The AWS page, re-read on 2026-10-09, still lists `SET` commands and `set_config` among the PostgreSQL pinning conditions and still says that calling stored procedures and functions does not pin, so the decision above stands and no new ADR is needed. It now also names `DEALLOCATE` and `EXECUTE` beside `PREPARE`, loading a library module such as `auto_explain`, and `DISCARD ALL` as a pool's reset query, none of which the service sends, and notes that transaction-level advisory locks (`pg_advisory_xact_lock` and its variants) do not pin. The owner decided that the migration task, and the one-off bootstrap task that creates the roles, connect to the RDS instance directly, not through RDS Proxy, so node-pg-migrate's session advisory lock never pins a proxy connection; and that a CloudWatch alarm fires when `DatabaseConnectionsCurrentlySessionPinned` has a Maximum above 0 over 5 minutes (sections 1.7 and 1.8 of spec 008, DEP-R28, DEP-R38 to DEP-R41).
