# Runbook: idempotency cleanup

`npm run idempotency:cleanup` deletes the idempotency keys whose TTL has passed (IDM-R22, section 1.4 of [spec 005](../../specs/005-idempotency/spec.md)). It only bounds the size of the `idempotency_keys` table: a key expires at its TTL whether or not the cleanup ran, because a request with an expired key replaces the row and runs as a new request (IDM-R21).

It runs:

- in AWS, every hour, as the scheduled task `scf-idempotency-cleanup` (DEP-R37), through RDS Proxy as `scf_app`, logging to `/scf/idempotency-cleanup`;
- locally, by hand, when the development database has grown, or to check the command after a change;
- never inside the service, so replicas never race on it.

It is safe to run at any time while the service is serving. It deletes only expired rows, and skips a row that a request in progress holds (`FOR UPDATE SKIP LOCKED`) instead of waiting for it; that row goes on the next run. It deletes in batches of 1000 rows, oldest expiry first, each batch in its own database transaction, until a batch deletes fewer than 1000. Each transaction raises its statement timeout to 600000 ms (10 minutes, SEC-R48). It waits at most 10 seconds to connect.

## Symptoms and alerts

| Alert                                                                                                 | Fires when                                                                                      |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `idempotency-cleanup-failed` ([alerts without an alarm](../observability.md#alerts-without-an-alarm)) | the scheduled task stops with an exit code other than 0, or did not run within the last 2 hours |
| `scf-rds-storage` ([alarms](../observability.md#alarms))                                              | storage runs out; a large `idempotency_keys` table is one cause ([database](database.md))       |

## Impact

One failed run has no effect on clients: keys expire at their TTL either way, and the next hour's run deletes what this one left. Runs that keep failing let the table grow by one TTL of traffic per hour, which costs storage and makes the key insert of every movement slower over time. Nothing is ever lost: an expired key that stays in the table is replaced by the next request that uses it.

## Diagnosis

1. The last runs and their exit codes. The task writes one line of JSON on stdout when it is done, `{"deleted": 1234}`, and on failure one line on stderr with the SQLSTATE, if there is one, never the URL or a driver message, which may hold credentials:

   ```sh
   aws logs tail /scf/idempotency-cleanup --since 3h
   aws ecs list-tasks --cluster <cluster> --family scf-idempotency-cleanup --desired-status STOPPED
   aws ecs describe-tasks --cluster <cluster> --tasks <task-arn> \
     --query 'tasks[0].{exitCode: containers[0].exitCode, reason: stoppedReason, stoppedAt: stoppedAt}'
   ```

   | Exit code | Meaning                                                                                                                                                |
   | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | 0         | Done: every expired row not held by a request in progress was deleted. `deleted` may be 0.                                                             |
   | 2         | It could not run: `DATABASE_URL` unset, the database unreachable within 10 seconds, or a statement failed. Stderr names the SQLSTATE, if there is one. |

2. A run that never started: the schedule and its last invocations, in the EventBridge Scheduler console, or `aws scheduler get-schedule --name scf-idempotency-cleanup`; a task that could not be placed shows in `stoppedReason`.
3. Read the SQLSTATE on stderr:
   - none, with `DATABASE_URL` set: the database did not answer; check that it is up and reachable from where the command runs ([database](database.md));
   - `57014`: a batch took longer than 10 minutes, which means the table is far larger than an hour of traffic or the database is overloaded;
   - `42501`: the role lacks a grant. The command needs `SELECT` and `DELETE` on `idempotency_keys` and `EXECUTE` on `app.set_statement_timeout`, which the migrations grant to `scf_app`;
   - `28P01`: the password was refused, as during the rotation of the runtime role's password ([secret rotation](secret-rotation.md)).
4. How many rows are expired and waiting. Locally (`docker compose exec postgres psql -U scf_app supercool_dev`):

   ```sql
   SELECT count(*) FILTER (WHERE expires_at <= now()) AS expired, count(*) AS total,
          pg_size_pretty(pg_total_relation_size('idempotency_keys')) AS size
   FROM idempotency_keys;
   ```

## Mitigation

1. Fix the cause from the SQLSTATE: the database's reachability or load, the grant (check that every migration is applied and the URL uses `scf_app`), or the password.
2. Run it again. In AWS, run the task once by hand like the migration task ([running a one-off task](../deployment/aws.md#running-a-one-off-task)) with `--task-definition scf-idempotency-cleanup`, in the tasks' security group (output `tasks_security_group_id`), since it connects through RDS Proxy. Locally:

   ```sh
   DATABASE_URL=postgres://scf_app:<password>@<host>:<port>/<database> npm run idempotency:cleanup
   ```

   Locally, `DATABASE_URL` comes from `.env`, so the command cleans the development database. Use the runtime role `scf_app`, as the service does. Against the local stack: `docker compose build --quiet tools && docker compose run --rm tools npm run idempotency:cleanup`.

3. After `57014`, run it again until it exits 0: each finished batch stays deleted, so every run makes progress.

Any failure leaves the table as it was before the failed batch.

## Verification

- The next run exits 0, and its `deleted` count falls back to about one hour of traffic.
- The query of the diagnosis shows few expired rows right after a run.

## Follow-up

- The alert `idempotency-cleanup-failed` is a documented signal, not a deployed alarm: an EventBridge rule on the task's state changes, or a metric filter on `/scf/idempotency-cleanup`, would deploy it.
- Runs that keep growing: check the traffic and `IDEMPOTENCY_KEY_TTL_SECONDS`, which sets how long each key stays.
