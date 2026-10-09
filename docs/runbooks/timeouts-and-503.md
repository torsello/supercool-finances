# Runbook: timeouts and 503

What a 503 means, how to find its cause, and what to do (sections 1.1, 1.7 and 1.9 of [spec 007](../../specs/007-security-ops/spec.md), [ADR-0019](../adr/0019-timeout-layers-and-rds-proxy.md), [ADR-0022](../adr/0022-request-timeout-answer-first-then-roll-back.md)). A 503 is a transient overload, never a defect: it is answered with `Retry-After: 1`, is never stored for idempotent replay, and leaves no committed effect, with the one exception of a commit already sent at the request timeout (below). A client retries the same request with the same `Idempotency-Key` (section 1.5 of [spec 008](../../specs/008-deployment/spec.md)).

## The timeout layers

Each layer gives up before the layer outside it, so the innermost layer that knows why answers (SYS-R35).

| Layer, innermost first  | Setting                                                   | Default                  | Answer when it runs out                                             |
| ----------------------- | --------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------- |
| Account row lock        | `ACCOUNT_LOCK_TIMEOUT_MS`                                 | 2000 ms                  | 503 `/problems/service-unavailable`                                 |
| Idempotency key wait    | `IDEMPOTENCY_WAIT_TIMEOUT_MS`                             | 2000 ms                  | 409 `/problems/request-in-progress`, not a 503                      |
| Database statement      | `statement_timeout` on the runtime role                   | 5 s                      | 503 `/problems/service-unavailable` (SQLSTATE 57014)                |
| Idle in transaction     | `idle_in_transaction_session_timeout` on the runtime role | 10 s                     | the database ends the session; only a defect reaches it             |
| Connection pool acquire | `DB_POOL_ACQUIRE_TIMEOUT_MS`                              | 2000 ms                  | 503 `/problems/service-unavailable`                                 |
| RDS Proxy borrow (AWS)  | `connection_borrow_timeout` on RDS Proxy                  | 5 s                      | 503 `/problems/service-unavailable` (SQLSTATE 08000)                |
| Redis command           | `REDIS_COMMAND_TIMEOUT_MS`                                | 100 ms                   | none: the per-user limit fails open ([rate limits](rate-limits.md)) |
| Service request         | `REQUEST_TIMEOUT_MS`                                      | 25000 ms                 | 503 `/problems/service-unavailable`                                 |
| Load balancer           | nginx `proxy_read_timeout`; the ALB idle timeout          | 30 s (nginx), 60 s (ALB) | 504 `/problems/upstream-unavailable` from nginx                     |

The service's keep-alive timeout, 65 s, stays above the load balancer's upstream keep-alive, 60 s, so the service never closes a connection the load balancer is about to reuse (SEC-R34).

## Finding the cause of a 503

1. Take the response's `X-Request-Id` (the body's `requestId`) and the body's `type`.
2. `type` `/problems/upstream-unavailable`: nginx answered, because no replica answered (502, 503) or none in time (504). Every replica is down or restarting: check `docker compose ps`. The outcome of a POST is unknown until the client retries it with the same key (DEP-R16).
3. `type` `/problems/service-unavailable`: a replica answered. Its log line `service unavailable`, at `warn` (level 40) with the same `reqId`, names the `cause`, and `sqlstate` when the database gave one:

| `cause`                      | What happened                                                                                                                                                                                                                                                                                              | Metric                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `PoolAcquireTimeout`         | No pool connection was free within `DB_POOL_ACQUIRE_TIMEOUT_MS`; nothing was written (SEC-R37).                                                                                                                                                                                                            | `scf_db_pool_acquire_timeouts_total`          |
| `ProxyBorrowTimeout`         | In AWS, RDS Proxy found no database connection within its 5 s borrow timeout (SQLSTATE 08000): a failover, or the proxy at its share of `max_connections`. The connection is destroyed, not reused (SEC-R49).                                                                                              | none of its own; `scf-rds-connections` in AWS |
| `AccountLockTimeout`         | An account row lock was not acquired within `ACCOUNT_LOCK_TIMEOUT_MS` (SQLSTATE 55P03).                                                                                                                                                                                                                    | `scf_lock_timeouts_total{lock="account"}`     |
| `RetriesExhausted`           | A deadlock or serialization failure (40P01, 40001) was still there after the third attempt.                                                                                                                                                                                                                | `scf_transaction_retries_exhausted_total`     |
| `StatementTimeout`           | A statement ran past `statement_timeout` (57014); the transaction rolled back, not retried (SEC-R32).                                                                                                                                                                                                      | none of its own                               |
| `RequestTimeout`             | The request was still running at `REQUEST_TIMEOUT_MS` (SEC-R33).                                                                                                                                                                                                                                           | none of its own                               |
| `ConnectionLost`             | The database connection was lost while a statement ran, `COMMIT` included: a database restart or failover, a terminated session (57P01), or a broken socket. Lost before `COMMIT`, nothing was written; lost during `COMMIT`, the outcome is unknown until the client retries with the same key (SEC-R57). |
| `ShuttingDown`, `PoolClosed` | The replica was shutting down ([shutdown](shutdown.md)).                                                                                                                                                                                                                                                   | none                                          |

`/health/ready` answering 503 is readiness, not a request failure: its `warn` line `not ready` names the failed `check`, `database` or `migrations` (SEC-R24), and a replica that is shutting down answers it with 503 too (SEC-R26).

Locally the logs are `docker compose logs api-1 api-2`; in AWS, the log group `/scf/api`. The metrics are on `METRICS_PORT` of each replica: `docker compose exec api-1 wget -qO- http://127.0.0.1:9464/metrics` locally; in AWS no security group admits that port ([observability](../deployment/aws.md#observability)).

## What to do

- **Pool exhausted.** `scf_db_pool_connections{state="waiting"}` stays above 0 and `scf_db_pool_acquire_timeouts_total` rises. Short bursts queue in arrival order and drain without a 5xx (SEC-R38); a steady excess needs more capacity. Raising `DB_POOL_MAX` must keep replicas × (`DB_POOL_MAX` + 1) + 10 below the database's `max_connections` − `superuser_reserved_connections` in every deployment: 2 × 11 + 10 = 32 < 97 in `compose.yaml`; in AWS a deployment's surge included, `max_tasks` 6 × `deployment_maximum_percent` 200 / 100 = 12 tasks, 12 × 11 + 10 = 142 < 197 with the parameter group's `max_connections` of 200; the tasks connect to RDS Proxy, which uses at most 90% of the instance's connections (SEC-R36, DEP-R29). In AWS the Terraform validation of `max_tasks` refuses any tfvars that breaks the budget, and the unit test of SEC-AC29 checks `compose.yaml` and the Terraform's defaults.
- **Lock timeouts.** Many movements on the same account at once: they queue on its row lock in ascending id order (ADR-0008). Occasional 503s under such contention are expected and retried by the client. If they persist with low traffic, look for a session holding a lock: `SELECT pid, state, xact_start, query FROM pg_stat_activity WHERE state <> 'idle' ORDER BY xact_start;`.
- **Retries exhausted.** `scf_transaction_retries_total` by `sqlstate` shows which conflict. Ordered locking should make deadlocks rare; a sustained rise is a defect to report.
- **Statement timeouts.** A slow statement: check the database's load (the alarm `scf-rds-cpu` in AWS) and `pg_stat_activity`. Do not raise `statement_timeout`: it must stay above the lock waits and below `REQUEST_TIMEOUT_MS` (SEC-R34), and it bounds the clean-up after a request timeout.
- **Request timeouts.** The request ran longer than its whole budget. Its transaction rolls back once the statement in flight ends; if its `COMMIT` was already sent, the commit finishes after the 503, the outcome is unknown to the client, and a retry with the same key gets the stored response (SEC-R33, SEC-AC38). Nothing needs repair; locally `npm run reconcile` confirms it ([reconciliation](reconciliation.md)). It runs locally and in CI only: in AWS it has no task yet ([limitations](../deployment/aws.md#limitations-and-follow-ups)).
- **Database down or failing over.** Every request needing the database answers 503 and readiness answers 503; liveness stays 200, so neither Docker nor ECS replaces the replicas, and they serve again once the database is back ([database failover](../deployment/aws.md#database-failover)).

## Changing a timeout

Configuration is read only at startup. The loader refuses a budget that does not hold, naming the variables (SEC-R35, SEC-R40):

- `REQUEST_TIMEOUT_MS` must be greater than `DB_POOL_ACQUIRE_TIMEOUT_MS` + `REDIS_COMMAND_TIMEOUT_MS` + 3 × (`IDEMPOTENCY_WAIT_TIMEOUT_MS` + 2 × `ACCOUNT_LOCK_TIMEOUT_MS`) + 30, 20130 ms with the defaults.
- `SHUTDOWN_TIMEOUT_MS` must not be less than `REQUEST_TIMEOUT_MS`.
- `ACCOUNT_LOCK_TIMEOUT_MS` and `IDEMPOTENCY_WAIT_TIMEOUT_MS` end at 4999 ms, below `statement_timeout`.

`REQUEST_TIMEOUT_MS` must also stay below the load balancer's timeout in every deployment (SEC-R47): below nginx's `proxy_read_timeout` of 30 s in `compose.yaml`, and below the ALB idle timeout of 60 s in AWS, which the Terraform variable `request_timeout_ms` also validates against `alb_idle_timeout_seconds`. The unit test of SEC-AC36 checks both. The ALB idle timeout itself must stay below the service's keep-alive of 65 s, which `alb_idle_timeout_seconds` validates too.

## AWS alarms

| Alarm                              | What it suggests                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| `scf-alb-5xx`                      | 5xx above 1% of requests over 5 minutes: find the `cause` in `/scf/api`.                    |
| `scf-alb-target-response-time-p99` | p99 above 300 ms: lock contention, a slow database or too few tasks.                        |
| `scf-alb-healthy-targets`          | fewer than 2 healthy tasks: tasks crashing or a deployment that never turns healthy.        |
| `scf-rds-connections`              | RDS Proxy above 80% of its connection limit: pool budget or task count.                     |
| `scf-rds-cpu`                      | the database is the bottleneck: statement timeouts follow.                                  |
| `scf-rds-proxy-pinned`             | a session is pinned to a database connection, which defeats the proxy's pooling (ADR-0019). |
