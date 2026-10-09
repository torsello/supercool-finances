# Runbook: database

What to do when the AWS database fails over, or when one of its alarms fires: `scf-rds-cpu`, `scf-rds-storage`, `scf-rds-connections` or `scf-rds-proxy-pinned` (section 1.8 of [spec 008](../../specs/008-deployment/spec.md), [ADR-0014](../adr/0014-aws-deployment-on-ecs-fargate-with-rds-postgresql.md), [ADR-0019](../adr/0019-timeout-layers-and-rds-proxy.md)). The database is RDS PostgreSQL 16, one Multi-AZ instance `scf`, fronted by the RDS Proxy `scf`, which the service and the cleanup task use; the migration and bootstrap tasks connect to the instance directly ([aws.md](../deployment/aws.md#database)).

PostgreSQL is the only source of truth (ADR-0005), so every alarm here can stop money from moving, but none of them can corrupt it: a movement commits whole, with its idempotency key row, or not at all.

## Symptoms and alerts

| Alarm ([observability](../observability.md#alarms)) | Fires when                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `scf-rds-cpu`                                       | the instance's average CPU is above 80% over 5 minutes                                                 |
| `scf-rds-storage` (EventBridge rule)                | RDS-EVENT-0225, 0224, 0223 or 0007: storage near or at the autoscaling maximum of 100 GB, or exhausted |
| `scf-rds-connections`                               | RDS Proxy's database connections are above 80% of `MaxDatabaseConnectionsAllowed` over 5 minutes       |
| `scf-rds-proxy-pinned`                              | `DatabaseConnectionsCurrentlySessionPinned` is above 0 over 5 minutes                                  |

A failover has no alarm of its own. It shows as:

- a burst of 503 `/problems/service-unavailable` with `Retry-After: 1`, which pages through `scf-alb-5xx` when it passes 1% of the requests over 5 minutes;
- `warn` lines `service unavailable` in `/scf/api` with `cause` `ProxyBorrowTimeout` (SQLSTATE 08000) or `ConnectionLost`, and `database connection lost`;
- readiness answering 503 with the `warn` line `not ready` and `check` `database`, while liveness stays 200;
- RDS events "Multi-AZ instance failover started" and "completed" for the instance `scf`.

## Impact

| Situation                     | What clients see                                                                                                                                                                                                                                                                                                                                  | Money                                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Failover (usually 1 to 2 min) | Every request that needs the database answers 503 with `Retry-After: 1`, after at most 5 s at RDS Proxy (`connection_borrow_timeout`), until the new primary takes connections. Tasks stay registered and are not replaced, and serve again without a restart. A request whose `COMMIT` was in flight has an unknown outcome until it is retried. | Nothing lost or applied twice: an open transaction rolls back with its key row, and a retry with the same `Idempotency-Key` runs it afresh or replays the stored answer. |
| `scf-rds-cpu`                 | Latency rises (`scf-alb-target-response-time-p99`), then 503s with `cause` `StatementTimeout` (57014), `AccountLockTimeout` or `PoolAcquireTimeout`.                                                                                                                                                                                              | Unaffected: a timed-out statement rolls back.                                                                                                                            |
| `scf-rds-storage`             | Nothing at 0225 and 0224. At 0223 the volume no longer grows. At 0007 the instance is `storage-full` and every write fails: movements answer 500 or 503, and reads keep working.                                                                                                                                                                  | Nothing committed is lost; new movements are refused.                                                                                                                    |
| `scf-rds-connections`         | Nothing yet. At the proxy's limit, requests wait up to 5 s for a connection and answer 503 (`ProxyBorrowTimeout`).                                                                                                                                                                                                                                | Unaffected.                                                                                                                                                              |
| `scf-rds-proxy-pinned`        | Nothing yet. Pinned connections are not shared, so the proxy runs out of database connections sooner, which leads to `scf-rds-connections`.                                                                                                                                                                                                       | Unaffected.                                                                                                                                                              |

## Diagnosis

No operator host reaches RDS Proxy or the instance in AWS ([limitations](../deployment/aws.md#limitations-and-follow-ups)), so in AWS the database is read through CloudWatch, RDS events, Performance Insights (enabled on the instance) and the RDS log files. The SQL below runs against the local stack, `docker compose exec postgres psql -U scf_app supercool_dev`, where it reproduces a problem.

### A failover

```sh
aws rds describe-events --source-type db-instance --source-identifier scf --duration 120 \
  --query 'Events[].[Date,Message]' --output table
aws rds describe-db-instances --db-instance-identifier scf \
  --query 'DBInstances[0].{status: DBInstanceStatus, az: AvailabilityZone, standbyAz: SecondaryAvailabilityZone}'
```

In the log group `/scf/api`, with CloudWatch Logs Insights, the 503s by cause per minute:

```text
filter msg = "service unavailable"
| stats count(*) by cause, sqlstate, bin(1m)
```

### `scf-rds-cpu`

1. Open Performance Insights for the instance `scf`: the top SQL and wait events of the last hour. Lock waits (`Lock:tuple`, `Lock:transactionid`) point at contention on hot accounts; CPU on one statement points at a plan or a scan.
2. Check whether traffic rose with it: the ALB's `RequestCount`, and the service's task count:

   ```sh
   aws ecs describe-services --cluster <cluster> --services scf-api \
     --query 'services[0].{desired: desiredCount, running: runningCount, deployments: length(deployments)}'
   ```

3. Locally, the sessions that are working and how long their transactions have been open:

   ```sql
   SELECT pid, state, wait_event_type, wait_event, now() - xact_start AS open_for, left(query, 80) AS query
   FROM pg_stat_activity
   WHERE datname = current_database() AND state <> 'idle'
   ORDER BY xact_start;
   ```

### `scf-rds-storage`

1. The event that fired, from the alarm's notification or `aws rds describe-events` above: 0225 (80% of the maximum), 0224 (the next step would reach it), 0223 (cannot scale) or 0007 (exhausted).
2. The allocated size and the maximum:

   ```sh
   aws rds describe-db-instances --db-instance-identifier scf \
     --query 'DBInstances[0].{allocatedGb: AllocatedStorage, maxGb: MaxAllocatedStorage}'
   ```

3. What takes the space. Locally:

   ```sql
   SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) AS size
   FROM pg_statio_user_tables ORDER BY pg_total_relation_size(relid) DESC;
   ```

   `ledger_entries`, `transactions` and `audit_records` grow with every movement and never shrink (the ledger is append-only). `idempotency_keys` should stay near one TTL of traffic: if it is large, the hourly cleanup is failing ([idempotency cleanup](idempotency-cleanup.md)).

### `scf-rds-connections`

1. Count the tasks: a rollout runs up to twice the desired count, up to 12 tasks at the autoscaling maximum, each with up to `DB_POOL_MAX` (10) connections ([aws.md](../deployment/aws.md#what-bounds-it)). The `describe-services` command above shows the running count and the deployments in progress.
2. Compare the proxy's `ClientConnections` and `DatabaseConnections` in CloudWatch (namespace `AWS/RDS`, dimension `ProxyName` `scf`). Many more database connections than active requests point at pinning (below).
3. Check for a session that did not come from the service: a migration or bootstrap task still running connects to the instance, not the proxy, but uses part of the 10% left outside the proxy's share.

### `scf-rds-proxy-pinned`

The service never sends `SET`: it sets its lock and statement timeouts through SQL functions, so its connections are never pinned (ADR-0019). A pinned connection means a session did something RDS Proxy cannot share: `SET`, a named prepared statement, an advisory lock, a temporary table, `LISTEN` or a cursor held across statements.

1. Find what changed when the alarm started: a deployment (a new image may have brought a library or a query that sends `SET`), or a one-off session through the proxy. node-pg-migrate holds an advisory lock for its whole run, which is why the migration task connects to the instance and never to the proxy.
2. Correlate with the cleanup schedule: the cleanup task is the only other client of the proxy, and runs every hour.
3. Locally, reproduce the suspect path against the stack and read what the session sends, from PostgreSQL's log: `docker compose logs postgres`.

## Mitigation

### A failover

1. Do nothing to the service: the tasks serve again once the new primary takes connections, without a restart, and clients retry with the same key (section 1.5 of spec 008).
2. If the 503s last beyond 5 minutes, check the instance status above. A failover that does not complete is an RDS incident: open an AWS support case.
3. If the instance is lost without a standby, restore it from the automated backups to a point in time within 7 days (`aws rds restore-db-instance-to-point-in-time`), point the Terraform at the restored instance, and reconcile the ledger before reopening traffic ([reconciliation](reconciliation.md)).

To rehearse a failover in a test environment: `aws rds reboot-db-instance --db-instance-identifier scf --force-failover`.

### `scf-rds-cpu`

1. If a deployment started it, roll back the code ([deploy and migrate](deploy-and-migrate.md#rollback)).
2. If traffic grew, the instance is the bottleneck: autoscaling more tasks does not help and adds connections. The instance class is a literal of the `database` module; changing it is a Terraform change applied in a maintenance window, with a Multi-AZ failover of about a minute.
3. Never raise `statement_timeout`: it bounds every statement below `REQUEST_TIMEOUT_MS` (SEC-R34).

### `scf-rds-storage`

1. At 0225 or 0224: plan more room. Raise the Terraform variable `db_max_allocated_storage_gb` and apply; the autoscaling maximum grows without downtime.
2. At 0223: read the event's message for the reason (often the 6-hour wait between two modifications), then raise the maximum as above.
3. At 0007: grow the volume at once, `aws rds modify-db-instance --db-instance-identifier scf --allocated-storage <gb> --max-allocated-storage <gb> --apply-immediately`, then set `db_max_allocated_storage_gb` to the same maximum, so the next apply does not lower it. RDS refuses a storage change within 6 hours of the last one; until then, writes keep failing and only reads are served.
4. If `idempotency_keys` is the cause, fix the cleanup ([idempotency cleanup](idempotency-cleanup.md)). Ledger tables are never deleted from.

### `scf-rds-connections`

1. During a rollout, wait for `aws ecs wait services-stable`: the old tasks stop and their connections close.
2. Outside a rollout, check that autoscaling did not pass `max_tasks`, and that nothing else connects through the proxy.
3. To make room for good: raise `db_max_connections` (a static parameter, applied at the next reboot, so in a maintenance window) or lower `db_pool_max` or `max_tasks`. The Terraform validation refuses any combination that breaks the budget of section 1.9 of spec 007.

### `scf-rds-proxy-pinned`

1. If a deployment brought it, roll back the code, then find the statement that pins locally before deploying again.
2. If a manual session through the proxy brought it, end that session.

## Verification

- The alarm returns to OK, which notifies the SNS topic.
- After a failover: `/scf/api` shows no new `service unavailable` lines with `cause` `ProxyBorrowTimeout` or `ConnectionLost`, the ALB's 5xx rate is back to its baseline, and a `GET /health/ready` through the ALB answers 200.
- After storage: `AllocatedStorage` and `MaxAllocatedStorage` show the new values.
- After connections: the proxy's `DatabaseConnections` is back below 80% of `MaxDatabaseConnectionsAllowed`.
- After a restore from backup: `npm run reconcile` exits 0 against the restored database before traffic returns ([reconciliation](reconciliation.md)); in AWS this needs the one-off task of the follow-ups below.

## Follow-up

- Record the failover's length: ADR-0014 says to watch it, since it decides whether Aurora's faster failover is worth its cost.
- A one-off task that runs `npm run reconcile` and read-only SQL in AWS, so the diagnosis above does not depend on Performance Insights alone ([limitations](../deployment/aws.md#limitations-and-follow-ups)).
- For pinning, a test that fails when a new code path sends `SET` through the pool.
