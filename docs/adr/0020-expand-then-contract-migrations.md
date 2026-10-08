# ADR-0020: Expand-then-contract migrations

- **Status:** Accepted
- **Date:** 2026-10-08
- **Related specs:** 007-security-ops, 008-deployment

## Context and problem

The service is deployed as a rolling update: for a while, replicas of the old and the new version run side by side against one database (DEP-R27). The schema must change without downtime and without breaking the version still running. Several replicas start at the same time, and the service connects with a runtime role that cannot change the schema (ADR-0018). The question is when and how migrations run, and what a migration may change.

## Decision drivers

- No downtime and no errors for the running version during a deploy.
- Exactly one migration run per deploy, never a race between replicas.
- Schema changes need the owner role, which the replicas never hold (DEP-R05).
- A failed migration stops the deploy before any replica of the new version starts (DEP-R03).

## Considered options

### Option A: A separate one-off migration task before the rollout, with expand-then-contract changes

- **Pros:**
  - Migrations run once, with the owner role, as a `migrate` job locally and a one-off ECS task in AWS, and the replicas start only after it exits 0 (DEP-R02, DEP-R03, DEP-R28).
  - Every change is backwards compatible with the running version: first expand (add tables, nullable columns, new functions), deploy the code that uses them, and only in a later release contract (drop what the old code used).
  - Readiness accepts migrations newer than the code, so a replica of the previous version stays ready while the next one rolls out (SEC-R24).
  - Deploys and schema changes are decoupled: a migration can ship before the code that needs it.
- **Cons:**
  - A breaking change takes two or more releases instead of one.
  - Discipline: every migration must be reviewed for compatibility with the previous version.
  - Old columns or tables linger until the contract release.

### Option B: Migrations at service startup

- **Pros:**
  - Simplest: no separate job; a fresh environment migrates itself.
- **Cons:**
  - Replicas race to run the same migration (or need a lock to avoid it).
  - The replicas would need the owner role, against ADR-0018.
  - Couples deploys to schema changes: a slow or failing migration blocks or crashes every replica.

### Option C: Breaking migrations with a maintenance window

- **Pros:**
  - One release per change; no transitional schema.
- **Cons:**
  - Downtime for every breaking change, unacceptable for a balance service.

## Decision

Chosen option: **Option A**. Migrations run as a separate one-off task before the new version rolls out, and every change is backwards compatible with the running version; readiness accepts migrations newer than the code. Running migrations at service startup is simpler but races between replicas and couples deploys to schema changes.

Migrations are SQL files run by node-pg-migrate (ADR-0010) with `MIGRATION_DATABASE_URL`; running them on an up-to-date database applies nothing and exits 0 (DEP-R04). Readiness answers 503 if a migration the code ships is missing (SEC-R24). In AWS the pipeline runs the migration task and waits for exit code 0 before updating the service (section 1.7 of spec 008).

## Consequences

### Positive

- Deploys never need downtime for schema changes.
- A failed migration stops the deploy with the old version still serving.
- Rolling back the code is safe, because the schema still supports the previous version.

### Negative / costs

- Breaking changes are split across releases, and contract steps must be tracked so they are not forgotten.
- `migrate:down` is for development; in production the way back is a new forward migration.

### To monitor

- Readiness failures after a deploy, which would show a replica running against a schema missing its migrations.
- Duration of the migration task, especially for changes that lock large tables.

### Follow-ups

- Phase 05-schema: the first migrations and the readiness check against node-pg-migrate's table.
- Phase 10-runtime and 12-infra: the `migrate` job in `compose.yaml` and the one-off ECS task.
