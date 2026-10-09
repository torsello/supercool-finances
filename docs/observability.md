# Observability

For operators and contributors: what the service writes to its logs, the metrics it serves, its health endpoints and the alarms of the AWS deployment. The README gives the [summary](../README.md#observability-and-operations); the rules are in sections 1.4, 1.8 and 1.10 of [spec 007](../specs/007-security-ops/spec.md) and sections 1.8 and 1.9 of [spec 008](../specs/008-deployment/spec.md). Locally, everything below can be watched with the optional Prometheus and Grafana profile ([ADR-0023](adr/0023-optional-observability-off-by-default.md)).

## Contents

- [Logs](#logs)
- [Metrics](#metrics)
- [Dashboards](#dashboards)
- [Health endpoints](#health-endpoints)
- [Alarms](#alarms)
- [Alerts without an alarm](#alerts-without-an-alarm)
- [Error reporting](#error-reporting)

## Logs

Each replica writes one JSON object per line to standard output, with Fastify's logger (pino), configured in [src/platform/logging/logger.ts](../src/platform/logging/logger.ts). Docker Compose keeps them per container, and in AWS they go to the CloudWatch log group `/scf/api`, kept 30 days.

A transfer, as replica `api-2` logged it (`docker compose logs --no-log-prefix api-2`):

```text
{"level":30,"time":1791554629690,"pid":1,"hostname":"00f38500ff99","replicaId":"api-2","reqId":"6c3bb12c506b95b8c066cdb109ecb790","req":{"method":"POST","url":"/v1/accounts/01a120fa-287d-7359-9cfd-1f4a34e53ebb/transfers","remoteAddress":"10.210.0.128","headers":{"host":"localhost","x-forwarded-for":"10.210.0.128","x-forwarded-proto":"http","x-request-id":"6c3bb12c506b95b8c066cdb109ecb790","content-length":"101","user-agent":"curl/8.7.1","accept":"*/*","authorization":"[Redacted]","content-type":"application/json","idempotency-key":"[Redacted]"}},"msg":"incoming request"}
{"level":30,"time":1791554629716,"pid":1,"hostname":"00f38500ff99","replicaId":"api-2","reqId":"6c3bb12c506b95b8c066cdb109ecb790","res":{"statusCode":201},"responseTime":25.881045000001905,"msg":"request completed"}
```

| Field                 | Meaning                                                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `level`               | pino's number: 20 debug, 30 info, 40 warn, 50 error, 60 fatal. `LOG_LEVEL` (`info` by default) sets the lowest one written.                                    |
| `time`                | Milliseconds since the epoch.                                                                                                                                  |
| `pid`, `hostname`     | The process and the container.                                                                                                                                 |
| `replicaId`           | `REPLICA_ID` (`api-1`, `api-2` locally), or the host name when it is unset, so a line always says which replica wrote it.                                      |
| `reqId`               | The correlation id: the request's `X-Request-Id`. Every line written while handling a request has it; lines about the process or the pool have none.           |
| `req`                 | On "incoming request": the method, the path without its query string, the client address (from `X-Forwarded-For` only behind a trusted proxy) and the headers. |
| `res`, `responseTime` | On "request completed": the status and the time to answer, in milliseconds.                                                                                    |
| `msg`                 | What happened. A 500 is logged with its error and SQLSTATE; a failed readiness check with the check that failed.                                               |

**Correlation ids.** nginx forwards the client's `X-Request-Id`, or sets one, and the service keeps a value that matches `[A-Za-z0-9._:-]{1,128}`, otherwise generates a UUIDv7. The same id is in the response header, in the `requestId` of every problem body and in the audit record of a committed movement or status change. To follow one request across both replicas and nginx:

```sh
docker compose logs --no-log-prefix api-1 api-2 nginx | grep 6c3bb12c506b95b8c066cdb109ecb790
```

nginx writes its own access log as JSON, one line per request, with `requestId`, the replica that answered (`upstream`) and its status:

```text
{"time":"2026-10-09T14:03:49+00:00","msg":"request","remoteAddr":"10.210.0.128","method":"POST","path":"/v1/accounts/01a120fa-287d-7359-9cfd-1f4a34e53ebb/transfers","status":201,"bytes":205,"durationSeconds":0.027,"requestId":"6c3bb12c506b95b8c066cdb109ecb790","responseRequestId":"6c3bb12c506b95b8c066cdb109ecb790","upstream":"10.210.0.12:3000","upstreamStatus":"201"}
```

**Redaction.** The `Authorization`, `Cookie` and `Idempotency-Key` headers are written as `[Redacted]`, as the line above shows. Every line also passes through a scrubber that replaces the values of `JWT_SECRET`, `CURSOR_SECRET`, `PGPASSWORD`, `SENTRY_DSN` and the passwords of `DATABASE_URL` and `REDIS_URL`, raw or percent-encoded. Query strings are never logged, and neither are bodies (SEC-R21, SEC-R22).

## Metrics

Each replica serves Prometheus metrics at `GET /metrics` on its own server, on `METRICS_PORT` (9464), which the load balancer never routes to and no deployment publishes (SEC-R43). Every labelled counter exists from startup at 0 for each of its label values, so a graph shows 0 rather than nothing. They are defined in [src/platform/metrics/metrics.ts](../src/platform/metrics/metrics.ts) (table 1.4 of spec 007).

| Metric                                    | Type      | Labels                                                                                                | Meaning                                                                                                   |
| ----------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `scf_http_request_duration_seconds`       | histogram | `method`, `route` (the route template, or `unmatched`), `status_code`                                 | Time from receiving a request to sending its response. Its `_count` is the request rate.                  |
| `scf_money_movements_total`               | counter   | `kind` (`deposit`, `withdrawal`, `transfer`, `reversal`), `outcome` (`applied`, `rejected`, `failed`) | Movements that reached the idempotency step: a 201, a stored 4xx, or a 5xx. Replays are not counted here. |
| `scf_idempotent_replays_total`            | counter   | `kind` (the four movements and `account_creation`)                                                    | Responses answered from a stored key row.                                                                 |
| `scf_lock_timeouts_total`                 | counter   | `lock` (`account`, `idempotency`)                                                                     | SQLSTATE 55P03: at an account row lock (answered 503) or at the key insert (answered 409).                |
| `scf_transaction_retries_total`           | counter   | `sqlstate` (`40P01`, `40001`)                                                                         | Attempts retried after a deadlock or a serialization failure.                                             |
| `scf_transaction_retries_exhausted_total` | counter   | none                                                                                                  | Requests that ended with 503 after the last attempt.                                                      |
| `scf_db_pool_connections`                 | gauge     | `state` (`total`, `idle`, `waiting`)                                                                  | Connections of the request pool, and requests waiting for one.                                            |
| `scf_db_pool_acquire_timeouts_total`      | counter   | none                                                                                                  | Requests answered 503 because no connection was free within `DB_POOL_ACQUIRE_TIMEOUT_MS`.                 |
| `scf_rate_limited_total`                  | counter   | none                                                                                                  | Requests answered 429 by the per-user limit.                                                              |
| `scf_rate_limit_store_errors_total`       | counter   | none                                                                                                  | Per-user limit checks that failed open because Redis did not answer within `REDIS_COMMAND_TIMEOUT_MS`.    |

Node's default process metrics (CPU, memory, event loop lag, garbage collection) are served too. A sample from `api-1` after the examples of the [API guide](api/README.md), its Postman collection run included:

```sh
docker compose exec -T api-1 wget -qO- http://127.0.0.1:9464/metrics | grep -E '^scf_(money|idempotent|lock)'
```

```text
scf_money_movements_total{kind="deposit",outcome="applied"} 0
scf_money_movements_total{kind="deposit",outcome="rejected"} 1
scf_money_movements_total{kind="deposit",outcome="failed"} 0
scf_money_movements_total{kind="withdrawal",outcome="applied"} 2
scf_money_movements_total{kind="withdrawal",outcome="rejected"} 1
scf_money_movements_total{kind="withdrawal",outcome="failed"} 0
scf_money_movements_total{kind="transfer",outcome="applied"} 0
scf_money_movements_total{kind="transfer",outcome="rejected"} 0
scf_money_movements_total{kind="transfer",outcome="failed"} 0
scf_money_movements_total{kind="reversal",outcome="applied"} 1
scf_money_movements_total{kind="reversal",outcome="rejected"} 1
scf_money_movements_total{kind="reversal",outcome="failed"} 0
scf_idempotent_replays_total{kind="deposit"} 0
scf_idempotent_replays_total{kind="withdrawal"} 1
scf_idempotent_replays_total{kind="transfer"} 1
scf_idempotent_replays_total{kind="reversal"} 0
scf_idempotent_replays_total{kind="account_creation"} 0
scf_lock_timeouts_total{lock="account"} 0
scf_lock_timeouts_total{lock="idempotency"} 0
```

Each replica counts only what it served: nginx balances round robin, so the totals are the sum over both.

In AWS the metrics port stays closed to everything outside the VPC, and nothing scrapes it yet: the alarms below use the metrics AWS publishes. Scraping it with an ADOT collector into Amazon Managed Service for Prometheus is the documented next step (section 6 of spec 008, [aws.md](deployment/aws.md)).

## Dashboards

`make observability` (or `docker compose --profile observability up --build --wait`) adds Prometheus, which scrapes `api-1:9464` and `api-2:9464` every 5 seconds inside the compose network and publishes no port, and Grafana on <http://localhost:3030>, anonymous and read-only ([local stack diagram](../README.md#local-stack)). `make down` stops both. The one dashboard, "SuperCool Finances" ([docker/grafana/dashboards/scf-overview.json](../docker/grafana/dashboards/scf-overview.json)), has these panels:

| Panel                               | Shows                                                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Replicas scraped                    | Prometheus's `up` for each replica.                                                                   |
| Requests by status class            | The request rate from `scf_http_request_duration_seconds`, by 2xx to 5xx.                             |
| Errors by status class              | The 4xx and 5xx rates, and the share of 5xx among all requests.                                       |
| Latency p50, p95 and p99            | Quantiles of `scf_http_request_duration_seconds` over the `/v1` routes.                               |
| Money movements by kind and outcome | `scf_money_movements_total`.                                                                          |
| Lock timeouts                       | `scf_lock_timeouts_total` by lock.                                                                    |
| Idempotent replays                  | `scf_idempotent_replays_total` by kind.                                                               |
| Rate-limited requests               | The rate of `scf_rate_limited_total`.                                                                 |
| Pool usage                          | `scf_db_pool_connections` by replica and state, and the rate of `scf_db_pool_acquire_timeouts_total`. |

Run `make load` against the profile to watch the stack under load. Prometheus keeps one day of data, inside its container.

Grafana's anonymous visitors cannot write queries, and Prometheus publishes no port, so a PromQL expression of the runbooks or of the [alerts without an alarm](#alerts-without-an-alarm) runs inside the Prometheus container:

```sh
docker compose exec -T prometheus wget -qO- \
  --post-data 'query=sum by (lock) (rate(scf_lock_timeouts_total[5m]))' http://localhost:9090/api/v1/query
```

## Health endpoints

Both are outside `/v1`, need no token, and are served on the public port ([src/platform/health/health.ts](../src/platform/health/health.ts)).

| Endpoint            | Checks                                                                                                                                                                  | 200                  | 503                                                                                                                       | Used by                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET /health/live`  | Only that the process answers.                                                                                                                                          | `{"status":"ok"}`    | never                                                                                                                     | The image's `HEALTHCHECK`, the ECS container health check and the ALB target group. |
| `GET /health/ready` | `SELECT 1` and that every migration the code ships is applied, on a connection kept apart from the request pool, within 1000 ms. From the start of a shutdown, nothing. | `{"status":"ready"}` | `/problems/service-unavailable`, without `Retry-After`; a `warn` line names the failed check (`database` or `migrations`) | The seed and the e2e suite, before they start; an operator.                         |

Liveness checks nothing outside the process on purpose: a database outage must not make Docker or ECS replace every replica at once (SEC-R23). On SIGTERM, readiness answers 503 for `SHUTDOWN_DRAIN_DELAY_MS` before the replica stops accepting connections; the [shutdown runbook](runbooks/shutdown.md) has the whole sequence.

## Alarms

The alarms are CloudWatch alarms of the AWS deployment, defined in [infra/terraform/modules/observability/alarms.tf](../infra/terraform/modules/observability/alarms.tf) (section 1.8 of spec 008). Each alarm notifies the module's SNS topic when it fires and when it clears; the `rds-storage` EventBridge rule sends its events to the same topic. The local stack has no alerting: Prometheus there has no alert rules (section 6 of spec 008).

| Alarm (`scf-` prefix)            | Metric                                                                     | Fires when                                                                                                          | Runbook                                          |
| -------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `alb-5xx`                        | `HTTPCode_ELB_5XX_Count` + `HTTPCode_Target_5XX_Count` over `RequestCount` | above 1% of requests over 5 minutes                                                                                 | [Timeouts and 503](runbooks/timeouts-and-503.md) |
| `alb-target-response-time-p99`   | `TargetResponseTime`, p99                                                  | above 300 ms over 5 minutes (the target of SYS-R20)                                                                 | [Timeouts and 503](runbooks/timeouts-and-503.md) |
| `alb-healthy-targets`            | `HealthyHostCount`, minimum                                                | fewer than 2 over 1 minute                                                                                          | [Capacity](runbooks/capacity.md)                 |
| `ecs-cpu`                        | `CPUUtilization` of the service, average                                   | above 80% over 5 minutes                                                                                            | [Capacity](runbooks/capacity.md)                 |
| `ecs-memory`                     | `MemoryUtilization` of the service, average                                | above 80% over 5 minutes                                                                                            | [Capacity](runbooks/capacity.md)                 |
| `rds-cpu`                        | `CPUUtilization` of the instance, average                                  | above 80% over 5 minutes                                                                                            | [Database](runbooks/database.md)                 |
| `rds-connections`                | the proxy's `DatabaseConnections` over `MaxDatabaseConnectionsAllowed`     | above 80% over 5 minutes                                                                                            | [Database](runbooks/database.md)                 |
| `rds-proxy-pinned`               | `DatabaseConnectionsCurrentlySessionPinned`, maximum                       | above 0 over 5 minutes: a session setting pins connections ([ADR-0019](adr/0019-timeout-layers-and-rds-proxy.md))   | [Database](runbooks/database.md)                 |
| `cache-memory`                   | `DatabaseMemoryUsagePercentage` of each cache node                         | any node above 80% over 5 minutes                                                                                   | [Capacity](runbooks/capacity.md)                 |
| `waf-blocked-requests`           | `BlockedRequests` of the web ACL, sum                                      | above 1000 in 5 minutes                                                                                             | [Rate limits](runbooks/rate-limits.md)           |
| `rds-storage` (EventBridge rule) | RDS events RDS-EVENT-0225, 0224, 0223 and 0007                             | storage at 80% of the autoscaling maximum, a step would reach it, autoscaling cannot scale, or storage is exhausted | [Database](runbooks/database.md)                 |

Each alarm points at one runbook by subject: the database, capacity, timeouts and 503, or rate limits. Every runbook is indexed in [runbooks/README.md](runbooks/README.md).

## Alerts without an alarm

The situations below have a runbook but no deployed alarm. Section 1.8 of [spec 008](../specs/008-deployment/spec.md) fixes the CloudWatch alarms as exactly those above, the local Prometheus has no alert rules, and in AWS nothing scrapes the replicas' metrics yet (section 6 of spec 008). Each row names the signal that already exists and the condition to watch it for; the thresholds are starting points, to tune against the usual rate. Until one is deployed, an operator watches it: locally on the Grafana dashboard or with the expression in Prometheus, in AWS in CloudWatch Logs Insights or the ECS task's exit code, and in CI through the failing step. Deploying them as alarms is a follow-up that changes section 1.8 of spec 008.

| Alert                        | Signal                                                                                                                  | Fires when                                                                                                                | Runbook                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `db-pool-exhausted`          | `scf_db_pool_acquire_timeouts_total`; `service unavailable` lines with `cause` `PoolAcquireTimeout`                     | `sum(increase(scf_db_pool_acquire_timeouts_total[5m])) > 0`                                                               | [Timeouts and 503](runbooks/timeouts-and-503.md)               |
| `idempotency-in-progress`    | `scf_lock_timeouts_total{lock="idempotency"}`; `request completed` lines with `res.statusCode` 409                      | `sum(rate(scf_lock_timeouts_total{lock="idempotency"}[5m])) > 0.1`, 30 in 5 minutes                                       | [Idempotency in progress](runbooks/idempotency-in-progress.md) |
| `transaction-retries`        | `scf_transaction_retries_total`, `scf_transaction_retries_exhausted_total`; `deadlock detected` in PostgreSQL's log     | `sum(increase(scf_transaction_retries_exhausted_total[5m])) > 0`, or `sum(rate(scf_transaction_retries_total[5m])) > 0.1` | [Retry storm](runbooks/retry-storm.md)                         |
| `redis-unavailable`          | `scf_rate_limit_store_errors_total`; the `warn` line `Redis unavailable: the per-user rate limit lets requests through` | `sum(increase(scf_rate_limit_store_errors_total[5m])) > 0`, or the line                                                   | [Rate limits](runbooks/rate-limits.md)                         |
| `reconcile-drift`            | the exit code of `npm run reconcile`                                                                                    | exit code 1: CI's step after the integration tests, or a manual run                                                       | [Reconciliation](runbooks/reconciliation.md)                   |
| `ledger-write-rejected`      | `request failed` lines with `err.type` `LedgerWriteRejected`                                                            | any                                                                                                                       | [Reconciliation](runbooks/reconciliation.md)                   |
| `idempotency-cleanup-failed` | the exit code of the task `scf-idempotency-cleanup`; its log group `/scf/idempotency-cleanup`                           | an exit code other than 0, or no run in the last 2 hours                                                                  | [Idempotency cleanup](runbooks/idempotency-cleanup.md)         |
| `migration-failed`           | the exit code of the task `scf-migrate`; its log group `/scf/migrate`                                                   | an exit code other than 0; the pipeline stops                                                                             | [Deploy and migrate](runbooks/deploy-and-migrate.md)           |
| `deployment-rolled-back`     | the ECS service's deployment `rolloutState` and events                                                                  | `FAILED`: the circuit breaker rolled the deployment back                                                                  | [Deploy and migrate](runbooks/deploy-and-migrate.md)           |
| `task-exit-unclean`          | the exit code and `stoppedReason` of an `scf-api` task; a replica's last log lines                                      | exit code 1 or 137 instead of 0                                                                                           | [Shutdown](runbooks/shutdown.md)                               |
| `secret-rotation`            | none: an operator's decision                                                                                            | the rotation schedule, someone who knew a secret leaves, or a secret reached a log, a ticket or a repository              | [Secret rotation](runbooks/secret-rotation.md)                 |
| `compromised-account`        | none: a report                                                                                                          | a customer disputes movements, support sees an unusual pattern, or the token issuer reports a breach                      | [Compromised account](runbooks/compromised-account.md)         |

## Error reporting

Off by default ([ADR-0023](adr/0023-optional-observability-off-by-default.md), section 1.10 of spec 007). With `SENTRY_DSN` set, each replica reports every request answered 500 `/problems/internal-error` to that Sentry-compatible endpoint, with its own small client on Node's `fetch` ([src/platform/error-reporting/](../src/platform/error-reporting/)). Nothing else is reported: no 4xx, no 503 and no error outside a request.

```sh
SENTRY_DSN=https://<public key>@<host>/<project id> \
  docker compose -f compose.yaml -f compose.error-reporting.yaml up --build --wait
```

`compose.yaml` never passes `SENTRY_DSN`, and the override file refuses to start without it. The DSN must use `https://`, except for a loopback host.

| A report holds                                                                                                                                                                                  | A report never holds                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| The `requestId`, the route template, the method, the replica, the SQLSTATE when there is one, the error's type, its stack frames and its message, scrubbed of secrets, tokens, UUIDs and digits | A header, a query string, a body, a client address, an amount, an account id, a token or a secret |

Reporting never changes or delays an answer: a send is abandoned after 2 s, at most 20 reports wait per replica, and failures are dropped and logged once when sending starts failing and once when it recovers. In AWS it stays off, because the tasks have no outbound internet path.
