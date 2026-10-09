# Runbook: retry storm

What to do when money movements keep failing with deadlocks (SQLSTATE 40P01) or serialization failures (40001) and the service keeps retrying them (SYS-R18, SYS-R19 of [spec 000](../../specs/000-overview/spec.md), [ADR-0008](../adr/0008-read-committed-with-ordered-pessimistic-row-locks.md)). The service retries the whole database transaction, key insert included, up to 3 attempts in total, waiting a random 0 to 10 ms before the second attempt and 0 to 20 ms before the third ([src/platform/db/transaction-runner.ts](../../src/platform/db/transaction-runner.ts)). A request still failing after the third answers 503 with `cause` `RetriesExhausted`.

Movements lock customer accounts with `SELECT ... FOR UPDATE`, one by one in ascending id order, under READ COMMITTED, and never lock a system account's row (LED-R14). With that order, two movements cannot wait on each other, so deadlocks should not happen, and nothing the service runs uses an isolation level that raises 40001. A sustained rise is therefore a defect, or a session outside the service that locks rows in another order.

## Symptoms and alerts

- The alert `transaction-retries` ([observability](../observability.md#alerts-without-an-alarm)): `scf_transaction_retries_total` rises, or `scf_transaction_retries_exhausted_total` rises at all.
- 503 `/problems/service-unavailable` with `Retry-After: 1`, whose `warn` line `service unavailable` has `cause` `RetriesExhausted` and `sqlstate` `40P01` or `40001`.
- In AWS, the alarms `scf-alb-5xx` and `scf-alb-target-response-time-p99` once it is large enough ([timeouts and 503](timeouts-and-503.md)).
- PostgreSQL logs `ERROR: deadlock detected` with the processes and the statements involved.

## Impact

A retried attempt that then succeeds costs latency only. A request that exhausts its attempts answers 503 and applies nothing (SYS-R19, IDM-R17): its key row rolls back with it, so the client's retry with the same key runs the movement afresh. No money is lost or applied twice.

The cost grows with the storm: each failed request runs up to 3 times in the service, then is retried by the client every second (section 1.5 of [spec 008](../../specs/008-deployment/spec.md)), so the database does several times the work for the same traffic.

## Diagnosis

1. Which conflict, and how many. Locally with PromQL run inside the Prometheus container ([dashboards](../observability.md#dashboards)):

   ```text
   sum by (sqlstate) (rate(scf_transaction_retries_total[5m]))
   sum(rate(scf_transaction_retries_exhausted_total[5m]))
   ```

   The raw counters of one replica:

   ```sh
   docker compose exec -T api-1 wget -qO- http://127.0.0.1:9464/metrics | grep -E '^scf_transaction_retries'
   ```

2. The requests it hit. In `/scf/api` with CloudWatch Logs Insights (locally, `docker compose logs api-1 api-2 | grep RetriesExhausted`):

   ```text
   filter msg = "service unavailable" and cause = "RetriesExhausted"
   | stats count(*) by sqlstate, bin(1m)
   ```

   Then the paths of a few of those `reqId`s, from their `incoming request` lines, as in [idempotency in progress](idempotency-in-progress.md#diagnosis).

3. What deadlocked. PostgreSQL writes each deadlock with the two processes, the locks they waited for and their statements, without bind parameters:

   ```sh
   docker compose logs postgres | grep -A8 'deadlock detected'
   ```

   In AWS the instance keeps its logs without exporting them; list and read them:

   ```sh
   aws rds describe-db-log-files --db-instance-identifier scf --file-last-written <epoch-ms>
   aws rds download-db-log-file-portion --db-instance-identifier scf \
     --log-file-name <name> --output text | grep -A8 'deadlock detected'
   ```

4. How many the database counted since its statistics were last reset. Locally, `docker compose exec postgres psql -U scf_app supercool_dev`:

   ```sql
   SELECT deadlocks, xact_rollback, xact_commit FROM pg_stat_database WHERE datname = current_database();
   ```

5. Read the statements of the deadlock against the rule: the account locks of each movement in ascending id order, and no row lock or update on a system account. A statement that locks accounts in another order, updates a system account, or comes from a session that is not the service (a manual fix, a script) is the cause. A 40001 means some session runs at REPEATABLE READ or SERIALIZABLE and writes; the service's movements run at READ COMMITTED, and the reconciliation reads only.

6. Check when it started against the last deployment ([deploy and migrate](deploy-and-migrate.md)).

## Mitigation

1. If it started with a deployment, roll back the code ([deploy and migrate](deploy-and-migrate.md#rollback)). The schema stays: migrations are expand-then-contract.
2. If a session outside the service causes it, stop that session. Locally:

   ```sql
   SELECT pid, usename, application_name, now() - xact_start AS open_for, left(query, 80) AS query
   FROM pg_stat_activity WHERE datname = current_database() AND state <> 'idle';
   SELECT pg_cancel_backend(<pid>);
   ```

3. Do not raise the number of attempts or the backoff: both are counted in the budget of `REQUEST_TIMEOUT_MS` (SEC-R35), and more retries add load to a database that is already conflicting.
4. Clients retry each 503 after `Retry-After: 1`. If their retries keep the storm going, the per-user and per-IP limits bound them ([rate limits](rate-limits.md)).

## Verification

- `rate(scf_transaction_retries_total[5m])` is back to 0 or its usual level, and `scf_transaction_retries_exhausted_total` no longer rises.
- No new `deadlock detected` in PostgreSQL's log.
- `npm run reconcile` exits 0 ([reconciliation](reconciliation.md)), locally or in CI; a retried transaction either committed whole or not at all.

## Follow-up

- A deadlock between two of the service's own movements is a defect: report it with the deadlock log and add a test next to MOV-AC14 and REV-AC23, which prove that crossed transfers and reversals never deadlock.
- The alert `transaction-retries` is a documented signal, not a deployed alarm; in AWS it needs the metrics scraped ([observability](../observability.md#metrics)).
