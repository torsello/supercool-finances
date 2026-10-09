# Runbook: deploy and migrate

How a release reaches AWS, how its migrations run, and how to roll it back (section 1.7 of [spec 008](../../specs/008-deployment/spec.md), [ADR-0020](../adr/0020-expand-then-contract-migrations.md)). The commands, the outputs they use and the first deployment are in [docs/deployment/aws.md](../deployment/aws.md#deployment-and-migration-steps); nothing in this repository runs them (DEP-R34). Placeholders: `<cluster>` (output `cluster_name`), `<tag>` (the image tag).

## Symptoms and alerts

A deployment is a planned operation. This runbook is also where these alerts lead ([observability](../observability.md)):

| Alert                                                                                                    | Means                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `migration-failed` ([alerts without an alarm](../observability.md#alerts-without-an-alarm))              | The migration task stopped with an exit code other than 0; the pipeline stops before the service changes.                              |
| `deployment-rolled-back` ([alerts without an alarm](../observability.md#alerts-without-an-alarm))        | The ECS circuit breaker rolled a deployment back, because its tasks never turned healthy.                                              |
| `scf-alb-5xx`, `scf-alb-healthy-targets` ([alarms](../observability.md#alarms)) right after a deployment | The new version is live but fails: answers 5xx, or its tasks crash. The circuit breaker does not see a version that is live but wrong. |

## Impact

- **A failed migration.** None for clients: the pending migrations run in one transaction, so a failed run leaves the schema as it was, and the old version keeps serving on it. New code is not deployed.
- **A deployment rolled back by the circuit breaker.** None for clients: `deployment_minimum_healthy_percent` 100 keeps the old tasks serving until new ones are healthy, and the new ones never were.
- **A bad version that is live.** Clients get its errors until it is rolled back. Money stays correct: every movement is one transaction, whatever the version.

During every deployment, old and new versions serve side by side against one schema. Migrations only expand, so both work; old tasks drain before they stop, so no request is cut off ([shutdown](shutdown.md)).

## Diagnosis

1. The migration task's exit code and its one-line reason, with the SQLSTATE or the variable at fault, never a password, in the log group `/scf/migrate`:

   ```sh
   aws ecs describe-tasks --cluster <cluster> --tasks <task-arn> \
     --query 'tasks[0].{exitCode: containers[0].exitCode, reason: stoppedReason}'
   aws logs tail /scf/migrate --since 1h
   ```

2. The deployment's state and the service's events:

   ```sh
   aws ecs describe-services --cluster <cluster> --services scf-api \
     --query 'services[0].{deployments: deployments[].{status: status, rollout: rolloutState, reason: rolloutStateReason, taskDefinition: taskDefinition}, events: events[:10].message}'
   ```

3. Why new tasks did not turn healthy: the stopped tasks' reasons ([capacity](capacity.md#diagnosis)), and `invalid configuration` or `startup failed` in `/scf/api`.
4. For a version that is live but wrong: the 5xx by cause in `/scf/api` ([timeouts and 503](timeouts-and-503.md#diagnosis)), and `request failed` lines for 500s.

Locally, `docker compose up --build --wait` runs the one-shot `migrate` job first; a failed migration stops there, keeps the replicas down (DEP-AC03), and `docker compose logs migrate` names the failure.

## Mitigation

### Every deployment

The pipeline runs, in order, and stops at the first failure:

1. Build the image's runtime stage and push it with a new, immutable tag.
2. Register the migration task definition of that tag: `terraform apply -var image_tag=<tag> -target=module.service.aws_ecs_task_definition.migrate`.
3. Run the migration task with `aws ecs run-task` in the private subnets and the `one-off-db` security group ([running a one-off task](../deployment/aws.md#running-a-one-off-task)), wait for it to stop, and require exit code 0. On any other code, stop: the old version keeps serving.
4. Apply with the new tag: `terraform apply -var image_tag=<tag>`, then `aws ecs wait services-stable --cluster <cluster> --services scf-api`.

### A failed migration

1. Read the line in `/scf/migrate`. `another migration run holds the migration lock` means two runs overlapped: wait for the other to end and run the task again. Otherwise the SQLSTATE names the failure; nothing of the failed run stayed.
2. Fix the migration in a new release. A migration already applied in any environment is never edited: the fix is a new forward migration (ADR-0020).
3. Deploy again from step 1.

### Rollback

1. Apply the previous tag: `terraform apply -var image_tag=<previous tag>`, then `aws ecs wait services-stable --cluster <cluster> --services scf-api`. Tags are immutable in ECR, so the previous tag is the same image that ran before.
2. When there is no time for an apply: `aws ecs update-service --cluster <cluster> --service scf-api --task-definition scf-api:<previous revision>`, then the same wait. Terraform owns the service's task definition, so the next apply must carry the previous tag, or it rolls the new one out again.

The schema is not rolled back. Expand-then-contract keeps it compatible with the version just before, so a rollback by one release is safe. In production the way back for the schema is a new forward migration, never `migrate:down`, which is for development.

## Verification

- `aws ecs describe-services` shows one deployment, `COMPLETED`, on the expected task definition, with `runningCount` equal to `desiredCount`.
- `GET /health/ready` through the ALB answers 200: the database answers and every migration the code ships is applied (SEC-R24).
- The alarms `scf-alb-5xx` and `scf-alb-healthy-targets` stay OK for the next 15 minutes.

## Follow-up

- A deployment that was rolled back: find the cause before deploying again, and add a test that would have caught it.
- Deployment alarms on the ECS service would let the circuit breaker also roll back a version that is live but answers 5xx (section 1.7 of spec 008 sets none today).
- Rotating secrets, which also redeploys, is in [secret rotation](secret-rotation.md).
