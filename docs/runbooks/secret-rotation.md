# Runbook: secret rotation

How to rotate each secret of the AWS deployment with the least interruption, and what clients see while it happens ([aws.md](../deployment/aws.md#secrets), DEP-R31, [ADR-0012](../adr/0012-simulated-authentication-with-jwt-and-two-roles.md), [ADR-0018](../adr/0018-two-database-roles.md)). Placeholders: `<cluster>` (output `cluster_name`), `<tag>` (the running image tag).

Today not every rotation is free of interruption. The service verifies tokens with one `JWT_SECRET` and signs cursors with one `CURSOR_SECRET`, and the runtime database role has one password. What each rotation costs is stated below, together with the follow-up that would remove the cost.

| Secret              | Interruption                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| `scf/jwt-secret`    | 401 for tokens signed with the old value, and for a few minutes 401s on some tasks for either value  |
| `scf/cursor-secret` | 400 for cursors issued before; clients restart the list from its first page                          |
| `scf/db-owner`      | none                                                                                                 |
| `scf/db-runtime`    | new database connections are refused until the redeploy finishes: some 503s, in a maintenance window |
| `scf/redis`         | none for money; at worst the per-user rate limit fails open until the redeploy finishes              |
| RDS master password | none: RDS rotates it in its own secret, and only the bootstrap task reads it                         |

## Symptoms and alerts

No alarm starts a rotation. The alert `secret-rotation` ([observability](../observability.md#alerts-without-an-alarm)) is an operator's decision:

- the rotation schedule of the organization;
- someone who knew a secret leaves, or a secret reached a place it must not be: a log, a ticket, a repository, a screen share;
- a suspected compromise ([compromised account](compromised-account.md)), where rotating `JWT_SECRET` is the way to invalidate every token at once.

The service never writes a secret to its logs (SEC-R22): a value in `/scf/api` would itself be a defect to report.

## Impact

- **`JWT_SECRET`.** Every token signed with the old value is refused with 401 `/problems/unauthenticated` once the task that receives it has the new value; each such request writes nothing, and the client retries it with a new token and the same `Idempotency-Key` (the key is scoped to the user, not the token). During the rolling deployment old and new tasks serve side by side, so for its length, a few minutes, a token is accepted by some tasks and refused by others. Tokens live at most 15 minutes (AUT-R05), so no old token outlives the rotation by more than that.
- **`CURSOR_SECRET`.** A `nextCursor` issued before is refused with 400 `/problems/malformed-request` (ACC-R23); the client lists again from the first page. Nothing else changes.
- **The runtime role's password.** RDS Proxy checks a client's password against the secret's current value, and opens database connections with it, while the running tasks keep the old `PGPASSWORD` until they are replaced. Until each old task is replaced, its new pool connections are refused and requests may answer 503 `/problems/service-unavailable`; connections it already holds keep working. Money is safe: a refused connection writes nothing, and the client retries with the same key.
- **The Redis token.** The tasks read `REDIS_URL`, token included, at start. A task whose token Redis no longer accepts fails open on the per-user limit (SEC-R06); the per-IP limit of WAF still applies.

## Diagnosis

Before a rotation, confirm what will be needed:

```sh
aws secretsmanager describe-secret --secret-id scf/jwt-secret --query '{changed: LastChangedDate, versions: VersionIdsToStages}'
aws ecs describe-services --cluster <cluster> --services scf-api --query 'services[0].{desired: desiredCount, running: runningCount, taskDefinition: taskDefinition}'
```

During and after it, in `/scf/api` with CloudWatch Logs Insights:

```text
filter msg = "authentication failed"
| stats count(*) by reason, bin(1m)
```

A peak of `reason` `signature` is tokens signed with the other value. For the database password, the 503s by cause:

```text
filter msg = "service unavailable"
| stats count(*) by cause, sqlstate, bin(1m)
```

## Mitigation

Each procedure, in the order that keeps the interruption shortest. Generate new values with `aws secretsmanager get-random-password --exclude-punctuation --password-length 40`, and never paste one into a ticket, a chat or a shell history that is kept.

### `JWT_SECRET`

1. Agree the time with whoever issues the tokens: the service issues none (AUT-R15). Pick a quiet hour.
2. Put the new value, at least 32 bytes and different from `CURSOR_SECRET`: `aws secretsmanager put-secret-value --secret-id scf/jwt-secret --secret-string <value>`.
3. Force a new deployment: `aws ecs update-service --cluster <cluster> --service scf-api --force-new-deployment`.
4. When the first new task is healthy, switch the issuer to the new value. Clients that get 401 fetch a new token and retry.
5. Wait for `aws ecs wait services-stable --cluster <cluster> --services scf-api`.

For a suspected leak, skip the agreement and do it at once: every token signed with the leaked value stops working as soon as the rollout ends.

### `CURSOR_SECRET`

Put the new value, at least 32 bytes and different from `JWT_SECRET`, then force a new deployment and wait as above. No coordination is needed.

### The owner role's password (`scf/db-owner`)

Put the new value, then run the bootstrap task, which sets both roles' passwords to their secrets' current values ([running a one-off task](../deployment/aws.md#running-a-one-off-task), with `--task-definition scf-bootstrap`), and require exit code 0. Only the migration and bootstrap tasks use it, so nothing is interrupted.

### The runtime role's password (`scf/db-runtime`)

In a maintenance window, in this order:

1. Before the window, register the bootstrap task definition of the running tag, `terraform apply -var image_tag=<tag> -target=module.service.aws_ecs_task_definition.bootstrap`, and have the commands ready.
2. Put the new value: `{"username": "scf_app", "password": "<value>"}`.
3. Run the bootstrap task at once and require exit code 0: it sets the role's password to the new value, so the proxy can open database connections again.
4. Force a new deployment at once and wait for `aws ecs wait services-stable`.

A cleanup run that falls in the window fails, and the next hour's run catches up ([idempotency cleanup](idempotency-cleanup.md)).

### The Redis token (`scf/redis`)

1. Put the new `auth_token` and the `url` with the same token: `{"auth_token": "<token>", "url": "rediss://:<token>@<primary endpoint>:6379"}`.
2. Raise `redis_auth_token_version` in the Terraform variables and apply with the running tag, `terraform apply -var image_tag=<tag>`: the write-only `auth_token_wo` sends the new token to ElastiCache, and nothing of it enters the plan or the state.
3. Force a new deployment and wait.

## Verification

- `aws ecs describe-services` shows one deployment, `COMPLETED`, with `runningCount` equal to `desiredCount`.
- `authentication failed` with `reason` `signature` falls back to its usual level within 15 minutes of the rotation of `JWT_SECRET`.
- No `service unavailable` lines with `ConnectionLost` or `PoolAcquireTimeout` after the rotation of the runtime password, and the next hourly cleanup exits 0 (log group `/scf/idempotency-cleanup`).
- No `Redis unavailable` line after the rotation of the Redis token, or a `Redis available` line after it.
- A request with a token signed with the new value answers 200, and one signed with the old value answers 401.

## Follow-up

These would remove the interruptions above. Section 6 of [spec 006](../../specs/006-auth/spec.md) leaves out accepting more than one `JWT_SECRET`, so each needs a spec change and an ADR first:

- **`JWT_SECRET`.** Verify with the current and the previous secret during a rotation (for example a `JWT_SECRET_PREVIOUS` accepted for one token lifetime), so the issuer and the tasks can change at different moments.
- **`CURSOR_SECRET`.** The same for cursors.
- **The runtime role.** An alternating two-user rotation: two login users for the runtime role, with the secret switching between them, so the old password stays valid until every task has the new one.
