# Architecture decision records

Every technical decision of the service is recorded here in MADR format, one file per decision: `NNNN-kebab-title.md`, numbered in order. The workflow is in [AGENTS.md](../../AGENTS.md#2-workflow-spec-first) and the `adr` skill (`.claude/skills/adr/`).

- An ADR is never rewritten once accepted. A changed decision gets a new ADR, and the old one is marked `Superseded by ADR-NNNN`.
- Each ADR names the specs it affects, and each of those specs lists it in its "Related ADRs" line.
- Where a spec fixes a detail, the ADR follows the spec.

| #    | Title                                                                                                                                  | Status   | Date       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------- |
| 0001 | [Spec-driven development with ADRs and AI agents](0001-spec-driven-development-with-adrs-and-ai-agents.md)                             | Accepted | 2026-10-07 |
| 0002 | [Modular monolith](0002-modular-monolith.md)                                                                                           | Accepted | 2026-10-07 |
| 0003 | [Hexagonal architecture with tactical DDD inside each module](0003-hexagonal-architecture-with-tactical-ddd.md)                        | Accepted | 2026-10-07 |
| 0004 | [TypeScript with Fastify](0004-typescript-with-fastify.md)                                                                             | Accepted | 2026-10-07 |
| 0005 | [PostgreSQL as the only source of truth](0005-postgresql-as-the-only-source-of-truth.md)                                               | Accepted | 2026-10-07 |
| 0006 | [Double-entry ledger with signed integer minor units](0006-double-entry-ledger-with-signed-integer-minor-units.md)                     | Accepted | 2026-10-07 |
| 0007 | [System accounts without a cached balance, never locked](0007-system-accounts-without-a-cached-balance.md)                             | Accepted | 2026-10-07 |
| 0008 | [Concurrency control with READ COMMITTED and ordered pessimistic row locks](0008-read-committed-with-ordered-pessimistic-row-locks.md) | Accepted | 2026-10-07 |
| 0009 | [Idempotency inside the movement's transaction](0009-idempotency-inside-the-movements-transaction.md)                                  | Accepted | 2026-10-08 |
| 0010 | [Kysely and pg instead of an ORM](0010-kysely-and-pg-instead-of-an-orm.md)                                                             | Accepted | 2026-10-08 |
| 0011 | [Amounts as strings in the API and bigint in the domain](0011-amounts-as-strings-in-the-api-and-bigint-in-the-domain.md)               | Accepted | 2026-10-08 |
| 0012 | [Simulated authentication with JWT and two roles](0012-simulated-authentication-with-jwt-and-two-roles.md)                             | Accepted | 2026-10-08 |
| 0013 | [Rate limiting at the edge and in Redis](0013-rate-limiting-at-the-edge-and-in-redis.md)                                               | Accepted | 2026-10-08 |
| 0014 | [AWS deployment on ECS Fargate with RDS PostgreSQL](0014-aws-deployment-on-ecs-fargate-with-rds-postgresql.md)                         | Accepted | 2026-10-08 |
| 0015 | [Terraform for infrastructure as code](0015-terraform-for-infrastructure-as-code.md)                                                   | Accepted | 2026-10-08 |
| 0016 | [Error model](0016-error-model.md)                                                                                                     | Accepted | 2026-10-08 |
| 0017 | [Keyset pagination with signed cursors](0017-keyset-pagination-with-signed-cursors.md)                                                 | Accepted | 2026-10-08 |
| 0018 | [Two database roles](0018-two-database-roles.md)                                                                                       | Accepted | 2026-10-08 |
| 0019 | [Timeout layers and RDS Proxy](0019-timeout-layers-and-rds-proxy.md)                                                                   | Accepted | 2026-10-08 |
| 0020 | [Expand-then-contract migrations](0020-expand-then-contract-migrations.md)                                                             | Accepted | 2026-10-08 |
