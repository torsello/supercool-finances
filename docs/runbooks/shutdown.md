# Runbook: shutdown

How a replica stops without losing requests, and what to do when one did not stop cleanly (section 1.8 of [spec 007](../../specs/007-security-ops/spec.md), SEC-R25 to SEC-R28). Docker Compose stops a replica on `docker compose stop` or `down`; ECS stops a task on a deployment, a scale-in or a replacement.

**A clean shutdown.** On SIGTERM or SIGINT, Node runs as process 1 with no shell or npm in between, so the signal reaches the service (DEP-R20). The replica then logs, in order:

1. `shutting down on SIGTERM: readiness answers 503`. From now on `/health/ready` answers 503 and `/health/live` still answers 200 (SEC-R26). The replica keeps serving for `SHUTDOWN_DRAIN_DELAY_MS` (2000 ms), so the load balancer stops sending it new requests first.
2. `stopped accepting connections`. New connections are refused and idle keep-alive connections are closed. A request that still arrives on a kept-alive connection is answered 503 `/problems/service-unavailable` with `Connection: close` (its `service unavailable` line has `cause` `ShuttingDown`), and the client retries it with the same `Idempotency-Key`.
3. The requests in flight finish, within `SHUTDOWN_TIMEOUT_MS` (30000 ms). The database pool, the readiness connection and Redis are closed.
4. `shutdown complete`, and the process exits with code 0 (SEC-R27).

A second signal during the shutdown is logged as `signal received during the shutdown: ignored` and changes nothing.

In AWS, ECS deregisters the task from the ALB target group first, which stops new requests and lets the ALB drain it for 35 s (`deregistration_delay`), then sends SIGTERM.

## Symptoms and alerts

| Alert                                                                                        | Fires when                                                                                       |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `task-exit-unclean` ([alerts without an alarm](../observability.md#alerts-without-an-alarm)) | an `scf-api` task or a replica stops with exit code 1 or 137 instead of 0                        |
| `scf-ecs-memory` ([alarms](../observability.md#alarms))                                      | the service's memory is above 80%, the usual cause of an exit code 137 ([capacity](capacity.md)) |

Locally, `docker compose ps -a` shows `Exited (1)` or `Exited (137)`. In the logs, one of the lines below.

## Impact

- **Exit code 0.** None: every request was answered.
- **Exit code 1, work cut off.** The requests still running were cut off: their connections were destroyed and their database transactions rolled back (SEC-R28). A client retrying with the same key gets either the stored response or a fresh run (spec 005), so money stays correct.
- **Exit code 137.** The replica was killed with SIGKILL before it could finish, so its requests in flight were lost to their clients as connection errors or 502s; they retry with the same key, with the same guarantee.

## Diagnosis

1. The exit code and the reason. Locally:

   ```sh
   docker compose ps -a api-1          # the exit code is in STATUS: Exited (0)
   docker compose logs api-1 | tail    # the lines above, and the ones below
   ```

   In AWS, the task's exit code and `stoppedReason`, and the lines in `/scf/api`:

   ```sh
   aws ecs describe-tasks --cluster <cluster> --tasks <task-arn> \
     --query 'tasks[0].{reason: stoppedReason, exitCode: containers[0].exitCode}'
   ```

2. Read the last lines the replica wrote:
   - `shutdown timeout reached: destroying the work still in flight`, at `warn` with `inFlight`, then `shutdown complete, work was cut off`: requests were still running when `SHUTDOWN_TIMEOUT_MS` ended. Since `SHUTDOWN_TIMEOUT_MS` is at least `REQUEST_TIMEOUT_MS` (SEC-R35), this happens only when a request outlived its own timeout, or when the clean-up after a request timeout, bounded by `statement_timeout`, was still running.
   - `the shutdown did not end in time: exiting`, at `error` with `limitMs`: a backstop fired at `SHUTDOWN_DRAIN_DELAY_MS` + `SHUTDOWN_TIMEOUT_MS` + 5000 ms (37 s with the defaults), because the shutdown itself hung, for example while closing a connection. A `failed to close a resource` line names the resource.
   - `uncaught error: shutting down`, at `fatal`: an uncaught exception or rejection ran the same shutdown and exits 1. Its `err` is the defect.
   - `invalid configuration` or `startup failed`: not a shutdown; the replica never started (SEC-R40). See [capacity](capacity.md#diagnosis).
   - No line at all after the last request, and exit code 137: the process was killed. Docker Compose waits `stop_grace_period` (40 s for `api-1` and `api-2`) and ECS waits the container's `stopTimeout` (40 s), both above `SHUTDOWN_DRAIN_DELAY_MS` + `SHUTDOWN_TIMEOUT_MS` (32 s) and, with the defaults, above the 37 s backstop too, so a shutdown never reaches the kill (DEP-R20, DEP-R27). A 137 means the container ran out of memory (`stoppedReason` `OutOfMemoryError`, the alarm `scf-ecs-memory`) or a changed setting broke that order.
3. For work cut off, find the requests: the `warn` lines `service unavailable` with `cause` `RequestTimeout` just before the shutdown, and the [timeouts runbook](timeouts-and-503.md) for why they were slow.

## Mitigation

1. Money needs nothing: a cut-off movement rolls back, and a retry with the same key replays or runs it once.
2. A shutdown that cut work off once, during an incident, needs nothing else. One that does it on every deployment is a defect to report, with the `inFlight` count and the slow requests.
3. An out-of-memory kill: see [capacity](capacity.md#scf-ecs-memory).
4. An uncaught error: roll back the release that brought it if it repeats ([deploy and migrate](deploy-and-migrate.md#rollback)) and report it with its `err`.
5. A setting that broke the order: restore it. The rules for changing the shutdown settings:
   - `SHUTDOWN_DRAIN_DELAY_MS` (0 to 60000) and `SHUTDOWN_TIMEOUT_MS` (1 to 120000, not less than `REQUEST_TIMEOUT_MS`) are read at startup; an invalid value stops the replica before it listens (SEC-R40).
   - Their sum must stay below `stop_grace_period` (40 s) in `compose.yaml` and below `stopTimeout` (40 s) in the Terraform (DEP-R20, DEP-R27); the Terraform variables refuse `shutdown_drain_delay_ms` + `shutdown_timeout_ms` + 5000 ms, the backstop, that is not below `stop_timeout_seconds`, so the backstop always fires before the kill, and a `shutdown_timeout_ms` below `request_timeout_ms` (SEC-R35). Going beyond means raising `stopTimeout` and `stop_grace_period` as well.

## Verification

Check a shutdown locally:

```sh
docker compose stop api-1
docker compose ps -a api-1          # Exited (0)
docker compose logs api-1 | tail    # shutting down ..., stopped accepting connections, shutdown complete
docker compose start api-1
```

nginx passes a request to the other replica when a connection fails or times out, and for a POST only if nothing of it was sent yet (DEP-R15). Any other request that meets the stopping replica gets an error or a 503, and the client retries it with the same key, so no movement is lost or applied twice (DEP-AC11).

In AWS, the next deployment's stopped tasks show exit code 0. If in doubt about money, `npm run reconcile` exits 0 ([reconciliation](reconciliation.md)); it runs locally and in CI only, and in AWS has no task yet ([limitations](../deployment/aws.md#limitations-and-follow-ups)).

## Follow-up

- The alert `task-exit-unclean` is a documented signal, not a deployed alarm: an EventBridge rule on ECS task state changes would deploy it.
- Report every `uncaught error` with its `err`: the service is meant to have none.
