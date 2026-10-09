# Runbook: deploy and migrate

How a release reaches AWS and how its migrations run (section 1.7 of [spec 008](../../specs/008-deployment/spec.md), [ADR-0020](../adr/0020-expand-then-contract-migrations.md)). The commands, the outputs they use and the first deployment are in [docs/deployment/aws.md](../deployment/aws.md); nothing in this repository runs them (DEP-R34).

## Every deployment

1. Build the image's runtime stage and push it with a new, immutable tag.
2. Register the migration task definition of that tag: `terraform apply -var image_tag=<tag> -target=module.service.aws_ecs_task_definition.migrate`.
3. Run the migration task with `aws ecs run-task` in the private subnets and the `one-off-db` security group, wait for it to stop, and require exit code 0. Stop the deployment on any other code: the old version keeps serving, and the task's log group `/scf/migrate` names the SQLSTATE.
4. Apply with the new tag: `terraform apply -var image_tag=<tag>`, then `aws ecs wait services-stable --cluster <cluster> --services scf-api`. A deployment that never turns healthy is rolled back by the circuit breaker.

Migrations are expand-then-contract, so the running version keeps working on the new schema. In production the way back for the schema is a new forward migration, never `migrate:down`; the way back for the code is applying the previous tag.

## Rotating the runtime role's password

Rotating `scf/db-runtime` interrupts new database connections until the redeploy finishes, so it is done in a maintenance window. RDS Proxy checks a client's password against the secret's current value and opens database connections with it, while the running tasks keep the old `PGPASSWORD` until they are replaced.

In this order, which keeps the window shortest:

1. Before the window, register the bootstrap task definition of the running tag and have the commands ready.
2. Put the new value in `scf/db-runtime` with `aws secretsmanager put-secret-value`.
3. Run the bootstrap task at once and require exit code 0: it sets the role's password to the new value, so the proxy can open database connections again.
4. Force a new deployment at once, `aws ecs update-service --cluster <cluster> --service scf-api --force-new-deployment`, and wait for `aws ecs wait services-stable`.

Until each old task is replaced, its new pool connections are refused and requests may answer 503; connections it already holds keep working. A cleanup run that falls in the window fails, and the next hour's run catches up.

Follow-up: an alternating two-user rotation removes the window. Two login users for the runtime role, with the secret switching between them, keep the old password valid until every task has the new one.

Rotating the other secrets needs no window: see "Rotating a secret" in [docs/deployment/aws.md](../deployment/aws.md).
