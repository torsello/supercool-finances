# Runbook: capacity

What to do when the service's tasks or the cache run short of room, or too few tasks are healthy: the alarms `scf-ecs-cpu`, `scf-ecs-memory`, `scf-cache-memory` and `scf-alb-healthy-targets` (section 1.8 of [spec 008](../../specs/008-deployment/spec.md)). The service runs as the ECS service `scf-api`, 2 to 6 Fargate tasks of 0.5 vCPU and 1 GB behind the ALB target group `scf-api`, scaled on 60% average CPU; Redis is the ElastiCache replication group `scf`, 2 `cache.t4g.small` nodes ([aws.md](../deployment/aws.md#scaling)).

The tasks hold no state, and Redis holds only the per-user rate-limit counters, so a capacity problem costs latency, 503s or the per-user limit, never money.

## Symptoms and alerts

| Alarm ([observability](../observability.md#alarms)) | Fires when                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `scf-ecs-cpu`                                       | the service's average CPU is above 80% over 5 minutes, above the autoscaling target of 60% |
| `scf-ecs-memory`                                    | the service's average memory is above 80% over 5 minutes                                   |
| `scf-cache-memory`                                  | any cache node's `DatabaseMemoryUsagePercentage` is above 80% over 5 minutes               |
| `scf-alb-healthy-targets`                           | the Minimum of `HealthyHostCount` is below 2 over 1 minute; no data counts as breaching    |

They often come with `scf-alb-target-response-time-p99` (latency) or `scf-alb-5xx` ([timeouts and 503](timeouts-and-503.md)).

## Impact

| Alarm                     | What clients see                                                                                                                                                                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scf-ecs-cpu`             | Autoscaling could not bring the CPU back to 60%, most often because it is at `max_tasks` (6). Latency rises; requests queue for pool connections and, past `DB_POOL_ACQUIRE_TIMEOUT_MS`, answer 503.                                                              |
| `scf-ecs-memory`          | Nothing yet. A task that reaches its 1 GB is killed by the kernel (exit code 137): its requests in flight are lost to the client as a connection error or a 502, and the client retries with the same key.                                                        |
| `scf-cache-memory`        | Nothing while there is room. At `maxmemory`, ElastiCache evicts keys, so some per-user counters restart from zero and the per-user limit is enforced less strictly. Money is not affected.                                                                        |
| `scf-alb-healthy-targets` | With 1 healthy task, the service runs on half its capacity in one zone and pages, because losing it means an outage. With 0, the ALB fails open and sends requests to every registered target anyway, or answers its own 503 `text/html` when none is registered. |

## Diagnosis

Placeholders: `<cluster>` (output `cluster_name`), `<task-arn>`.

### The service

1. The service's state, its recent events and the deployments in progress. Events such as "unable to place a task", "(task ...) failed container health checks" or "deployment failed" name the cause:

   ```sh
   aws ecs describe-services --cluster <cluster> --services scf-api \
     --query 'services[0].{desired: desiredCount, running: runningCount, deployments: deployments[].{status: status, rollout: rolloutState, running: runningCount}, events: events[:10].message}'
   ```

2. What autoscaling did, and whether it stopped at the maximum:

   ```sh
   aws application-autoscaling describe-scaling-activities --service-namespace ecs \
     --resource-id service/<cluster>/scf-api --max-items 10
   ```

3. The tasks that stopped, with their reason and exit code. 137 with `OutOfMemoryError` is a memory kill; 1 is a startup failure or an unclean shutdown ([shutdown](shutdown.md)):

   ```sh
   aws ecs list-tasks --cluster <cluster> --service-name scf-api --desired-status STOPPED
   aws ecs describe-tasks --cluster <cluster> --tasks <task-arn> \
     --query 'tasks[].{reason: stoppedReason, exitCode: containers[0].exitCode, stoppedAt: stoppedAt}'
   ```

4. The health of each target as the ALB sees it:

   ```sh
   aws elbv2 describe-target-health \
     --target-group-arn "$(aws elbv2 describe-target-groups --names scf-api --query 'TargetGroups[0].TargetGroupArn' --output text)"
   ```

5. In `/scf/api`, a task that never started logs `invalid configuration`, naming each invalid variable and its rule but never a value (SEC-R40), or `startup failed`, and exits with code 1:

   ```text
   filter msg in ["invalid configuration", "startup failed", "uncaught error: shutting down"]
   | sort @timestamp desc | limit 20
   ```

6. Per task, Container Insights (enabled on the cluster) shows CPU and memory over time. Memory that only grows across hours, with steady traffic, is a leak; memory that follows traffic is load.

Locally, the same questions:

```sh
docker compose ps -a                                   # health and exit codes
docker stats --no-stream api-1 api-2                   # CPU and memory per replica
docker compose exec -T api-1 wget -qO- http://127.0.0.1:9464/metrics \
  | grep -E '^(process_resident_memory_bytes|nodejs_heap_size_used_bytes|nodejs_eventloop_lag_seconds|scf_db_pool_connections)'
```

### The cache

1. Which node and how full, and whether it evicts: `DatabaseMemoryUsagePercentage`, `CurrItems` and `Evictions` in CloudWatch (namespace `AWS/ElastiCache`, dimension `CacheClusterId`), for the nodes of:

   ```sh
   aws elasticache describe-replication-groups --replication-group-id scf \
     --query 'ReplicationGroups[0].MemberClusters'
   ```

2. Every counter is one key per user active in the window, `scf:rate-limit:user:<id>`, with a TTL of `RATE_LIMIT_USER_WINDOW_S` (10 s). `CurrItems` far above the number of users active in 10 s means something else writes to the cache. Locally:

   ```sh
   docker compose exec -T redis redis-cli INFO memory | grep -E 'used_memory_human|maxmemory_human|evicted'
   docker compose exec -T redis redis-cli --scan --pattern 'scf:rate-limit:user:*' | wc -l
   docker compose exec -T redis redis-cli DBSIZE
   ```

## Mitigation

### `scf-ecs-cpu`

1. If a deployment started it, roll back the code ([deploy and migrate](deploy-and-migrate.md#rollback)).
2. If autoscaling is at `max_tasks` because traffic grew, check the database first ([database](database.md)): more tasks add connections and help only if the database has room. Then raise `max_tasks` in the Terraform variables and apply; the validation of `max_tasks` refuses a value that breaks the connection budget, 8 at most with the other defaults ([aws.md](../deployment/aws.md#what-bounds-it)).
3. If a few clients cause it, the per-IP limit of WAF and the per-user limit apply ([rate limits](rate-limits.md)).

### `scf-ecs-memory`

1. If a deployment started it, roll back the code.
2. If it is a leak, force a new deployment to replace the tasks while the cause is found, `aws ecs update-service --cluster <cluster> --service scf-api --force-new-deployment`: each task drains before it stops, so nothing is cut off ([shutdown](shutdown.md)).
3. If it is load, raise `task_memory` (and `task_cpu` in a valid Fargate pair) in the Terraform variables and apply: a rolling deployment.

### `scf-cache-memory`

1. If something other than the rate limiter writes to the cache, find and stop it: the service uses no other key.
2. If it is the number of active users, grow the nodes: a change of `node_type` in the `cache` module, applied by ElastiCache node by node with a failover in between. During the failover the per-user limit fails open for a moment ([rate limits](rate-limits.md)).

### `scf-alb-healthy-targets`

1. Read the service's events and the stopped tasks' reasons (Diagnosis 1 and 3).
2. A deployment whose tasks never turn healthy is rolled back by the circuit breaker; if it keeps retrying, roll back by hand ([deploy and migrate](deploy-and-migrate.md#rollback)).
3. A configuration error (`invalid configuration`, with the variables named in the log) is fixed in the Terraform variables or the secret and deployed again.
4. Tasks that cannot be placed (no capacity in a zone, a subnet out of addresses) recover on their own once the zone is back; ECS keeps the desired count in the other zone meanwhile ([aws.md](../deployment/aws.md#loss-of-an-availability-zone)).
5. Tasks that are healthy but answer 503 are not a capacity problem: the ALB checks liveness, not readiness. See [timeouts and 503](timeouts-and-503.md) and [database](database.md).

## Verification

- The alarm returns to OK.
- `describe-services` shows `runningCount` equal to `desiredCount`, one deployment `COMPLETED`, and `describe-target-health` every target `healthy`.
- For memory: Container Insights shows the new tasks' memory flat under steady traffic.
- For the cache: `DatabaseMemoryUsagePercentage` below 80% and `Evictions` at 0.

## Follow-up

- A load test at the new peak (`npm run load` locally, [performance](../performance.md)) before raising `max_tasks` for good.
- A memory leak is a defect: report it with the version, the growth rate and a heap snapshot taken locally under `npm run load`.
- Scraping the replicas' metrics in AWS (ADOT into Amazon Managed Service for Prometheus, [observability](../observability.md#metrics)) would show the event loop lag and the pool per task.
