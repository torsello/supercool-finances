# Runbooks

For operators: what to do when something goes wrong, or before a routine operation. Each runbook says what the symptom looks like, how to find the cause and what to do, with the commands to run. The signals they start from are described in [observability.md](../observability.md), and the AWS deployment in [aws.md](../deployment/aws.md).

| Runbook                                       | Use it when                                                                                                  | Spec                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| [Deploy and migrate](deploy-and-migrate.md)   | Releasing a new version to AWS, running its migrations, or a deployment or migration failed.                 | Section 1.7 of [spec 008](../../specs/008-deployment/spec.md)                 |
| [Timeouts and 503](timeouts-and-503.md)       | Clients get 503 `/problems/service-unavailable` or 409 `/problems/request-in-progress`, or latency rises.    | Sections 1.1, 1.7 and 1.9 of [spec 007](../../specs/007-security-ops/spec.md) |
| [Rate limits](rate-limits.md)                 | Clients get 429 `/problems/rate-limited`, or the per-user limit stops applying because Redis is unreachable. | Section 1.6 of [spec 007](../../specs/007-security-ops/spec.md)               |
| [Shutdown](shutdown.md)                       | A replica or task is stopping, or did not stop cleanly (exit code 1 or 137).                                 | Section 1.8 of [spec 007](../../specs/007-security-ops/spec.md)               |
| [Reconciliation](reconciliation.md)           | A balance looks wrong, after an incident that touched the database, or to check the ledger at any time.      | Section 1.5 of [spec 002](../../specs/002-ledger/spec.md)                     |
| [Idempotency cleanup](idempotency-cleanup.md) | The `idempotency_keys` table grows, or the hourly cleanup task failed.                                       | Section 1.4 of [spec 005](../../specs/005-idempotency/spec.md)                |
