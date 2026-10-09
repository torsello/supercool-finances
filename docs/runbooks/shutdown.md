# Runbook: shutdown

How a replica stops without losing requests, and what to do when one did not stop cleanly (section 1.8 of [spec 007](../../specs/007-security-ops/spec.md), SEC-R25 to SEC-R28). Docker Compose stops a replica on `docker compose stop` or `down`; ECS stops a task on a deployment, a scale-in or a replacement.

## What a clean shutdown looks like

On SIGTERM or SIGINT, Node runs as process 1 with no shell or npm in between, so the signal reaches the service (DEP-R20). The replica then logs, in order:

1. `shutting down on SIGTERM: readiness answers 503`. From now on `/health/ready` answers 503 and `/health/live` still answers 200 (SEC-R26). The replica keeps serving for `SHUTDOWN_DRAIN_DELAY_MS` (2000 ms), so the load balancer stops sending it new requests first.
2. `stopped accepting connections`. New connections are refused and idle keep-alive connections are closed. A request that still arrives on a kept-alive connection is answered 503 `/problems/service-unavailable` with `Connection: close` (its `service unavailable` line has `cause` `ShuttingDown`), and the client retries it with the same `Idempotency-Key`.
3. The requests in flight finish, within `SHUTDOWN_TIMEOUT_MS` (30000 ms). The database pool, the readiness connection and Redis are closed.
4. `shutdown complete`, and the process exits with code 0 (SEC-R27).

A second signal during the shutdown is logged as `signal received during the shutdown: ignored` and changes nothing.

## When it exits with code 1

- `shutdown timeout reached: destroying the work still in flight`, at `warn` with `inFlight`, then `shutdown complete, work was cut off`: requests were still running when `SHUTDOWN_TIMEOUT_MS` ended. Their connections were destroyed and their database transactions rolled back (SEC-R28). Since `SHUTDOWN_TIMEOUT_MS` is at least `REQUEST_TIMEOUT_MS` (SEC-R35), this happens only when a request outlived its own timeout, or when the clean-up after a request timeout, bounded by `statement_timeout`, was still running.
- `the shutdown did not end in time: exiting`, at `error` with `limitMs`: a backstop fired at `SHUTDOWN_DRAIN_DELAY_MS` + `SHUTDOWN_TIMEOUT_MS` + 5000 ms (37 s with the defaults), because the shutdown itself hung, for example while closing a connection.
- `startup failed`, or a configuration error naming variables: not a shutdown; the replica never started (SEC-R40).

What to do: money stays correct, because a cut-off movement rolls back and a client that retries with the same key gets either the stored response or a fresh run (spec 005). Locally, confirm with `npm run reconcile` if in doubt ([reconciliation](reconciliation.md)); it runs locally and in CI only, and in AWS has no task yet ([limitations](../deployment/aws.md#limitations-and-follow-ups)). Then find the requests that were cut off: the `warn` lines `service unavailable` with `cause` `RequestTimeout` just before the shutdown, and the [timeouts runbook](timeouts-and-503.md) for why they were slow. A shutdown that cut work off once during an incident needs nothing else; one that does it on every deployment is a defect to report.

## Exit code 137: killed before the deadline

Exit code 137 means the replica was killed with SIGKILL before it could finish. Docker Compose waits `stop_grace_period` (40 s for `api-1` and `api-2`) and ECS waits the container's `stopTimeout` (40 s), both above `SHUTDOWN_DRAIN_DELAY_MS` + `SHUTDOWN_TIMEOUT_MS` (32 s) and, with the defaults, above the 37 s backstop too, so this should not happen (DEP-R20, DEP-R27). If it does, check that a changed setting did not break that order, or that the container ran out of memory (in AWS, the alarm `scf-ecs-memory` and the task's `stoppedReason`).

## Checking a shutdown

Locally:

```sh
docker compose stop api-1
docker compose ps -a api-1          # the exit code is in STATUS: Exited (0)
docker compose logs api-1 | tail    # the lines above
docker compose start api-1
```

nginx passes a request to the other replica when a connection fails or times out, and for a POST only if nothing of it was sent yet (DEP-R15). Any other request that meets the stopping replica gets an error or a 503, and the client retries it with the same key, so no movement is lost or applied twice (DEP-AC11).

In AWS, ECS deregisters the task from the ALB target group first, which stops new requests and lets the ALB drain it for 35 s (`deregistration_delay`), then sends SIGTERM. The log group `/scf/api` holds the lines above. The exit code and the reason:

```sh
aws ecs describe-tasks --cluster <cluster> --tasks <task-arn> \
  --query 'tasks[0].{reason: stoppedReason, exitCode: containers[0].exitCode}'
```

## Changing the shutdown settings

- `SHUTDOWN_DRAIN_DELAY_MS` (0 to 60000) and `SHUTDOWN_TIMEOUT_MS` (1 to 120000, not less than `REQUEST_TIMEOUT_MS`) are read at startup; an invalid value stops the replica before it listens (SEC-R40).
- Their sum must stay below `stop_grace_period` (40 s) in `compose.yaml` and below `stopTimeout` (40 s) in the Terraform (DEP-R20, DEP-R27); the Terraform variables refuse `shutdown_drain_delay_ms` + `shutdown_timeout_ms` + 5000 ms, the backstop, that is not below `stop_timeout_seconds`, so the backstop always fires before the kill, and a `shutdown_timeout_ms` below `request_timeout_ms` (SEC-R35). Going beyond means raising `stopTimeout` and `stop_grace_period` as well.
