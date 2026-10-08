# ADR-0018: Two database roles

- **Status:** Accepted
- **Date:** 2026-10-08
- **Related specs:** 000-overview, 002-ledger, 007-security-ops, 008-deployment

## Context and problem

The database enforces the ledger's invariants as a second line of defence (ADR-0005): constraints, deferred triggers and an append-only ledger (section 1.3 of spec 002). Those checks protect against defects in the service only if the service cannot switch them off. A role that owns a table can drop its constraints, disable its triggers or alter it. Today `docker/postgres/init` creates one role, `scf`, for everything. The question is which database roles exist and which one the service uses.

## Decision drivers

- A bug or a compromised service cannot disable, drop or bypass the ledger checks (LED-R16, LED-R17).
- Transactions and ledger entries are never updated or deleted (SYS-R15).
- Migrations can still create and change the schema.
- Least privilege for the process exposed to the network.

## Considered options

### Option A: An owner role for migrations and a runtime role for the service, plus append-only triggers

- **Pros:**
  - The owner role runs the migrations and owns the tables; the service connects as a runtime role that is not a superuser, owns no table and holds only the privileges it needs, on the ledger only `SELECT` and `INSERT` (LED-R17).
  - The runtime role cannot `ALTER`, `DROP` or `DISABLE TRIGGER`, so it cannot turn off the checks.
  - Triggers reject `UPDATE`, `DELETE` and `TRUNCATE` on transactions and ledger entries even for the owner (LED-R16), so a mistaken migration cannot rewrite history through DML either.
  - Each role has its own connection URL and its own secret (DEP-R05, DEP-R31).
- **Cons:**
  - Grants must be maintained for every new table, sequence and function.
  - Two credentials to manage locally, in CI and in AWS.
  - The owner can still bypass the triggers through DDL, and a superuser bypasses everything; the protection relies on the service never connecting as either.

### Option B: One shared role

- **Pros:**
  - Simplest: one URL, no grants.
- **Cons:**
  - The application can turn off its own safety net: any code path, or an attacker with SQL injection, can disable triggers, drop constraints or update the ledger.

### Option C: Two roles without the append-only triggers

- **Pros:**
  - Privileges alone stop the runtime role from updating or deleting.
- **Cons:**
  - Nothing stops the owner role, which runs every migration, from updating or deleting ledger rows by mistake.

## Decision

Chosen option: **Option A**. An owner role runs the migrations and owns the tables; the service connects with a runtime role that holds only the privileges it needs (`SELECT` and `INSERT` on the ledger), so a bug or a compromised service cannot disable the database checks. Triggers reject `UPDATE`, `DELETE` and `TRUNCATE` on the ledger even for the owner; only DDL or a superuser could bypass them, and the service never connects as either. One shared role is simpler but lets the application turn off its own safety net.

The owner role also sets the runtime role's `statement_timeout` and `idle_in_transaction_session_timeout` with `ALTER ROLE` from a migration (SEC-R29), and only the runtime role may execute the lock-timeout function (SEC-R31, ADR-0019). The migrations run with `MIGRATION_DATABASE_URL`, locally in the `migrate` job and in AWS as a one-off task; the replicas and every other script use `DATABASE_URL` (DEP-R05, DEP-R28).

## Consequences

### Positive

- A defect or injection in the service cannot corrupt or erase the ledger (LED-AC11, LED-AC12).
- The service runs with the least privilege its features need.

### Negative / costs

- Every migration that adds a table or function must also grant the runtime role exactly what it needs; a missing grant fails at run time.
- Phase 05-schema replaces the single `scf` role of `docker/postgres/init` and the CI setup.

### To monitor

- Integration tests that the runtime role cannot update, delete, truncate or disable triggers (LED-AC11, LED-AC12).
- Review of every migration's grants.

### Follow-ups

- Phase 05-schema: create both roles, the grants, the append-only triggers and the role settings.
  - Done in phase 05-schema on 2026-10-08.
- Phase 12-infra: both credentials in Secrets Manager and in RDS Proxy (section 1.7 of spec 008).
