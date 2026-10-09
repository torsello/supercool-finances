# ADR-0014: AWS deployment on ECS Fargate with RDS PostgreSQL

- **Status:** Accepted
- **Date:** 2026-10-08
- **Related specs:** 000-overview, 005-idempotency, 007-security-ops, 008-deployment

## Context and problem

The challenge asks how the service would run in a cloud, expressed as infrastructure as code (docs/challenge.md). The service is a long-running, stateless HTTP process with a connection pool, graceful shutdown and health checks (spec 007), backed by PostgreSQL and Redis. The question is which AWS compute and database services run it.

## Decision drivers

- Long-lived stateless containers, so connection pooling and graceful shutdown work as designed (SEC-R25 to SEC-R28, SEC-R36).
- At least two replicas across two availability zones (DEP-R27).
- Managed database failover and backups (DEP-R29).
- Little server management for a single service.
- The same image locally and in AWS (spec 008).
- A database outage must not make the orchestrator replace every task.

## Considered options

### Option A: ECS Fargate behind an ALB, RDS PostgreSQL Multi-AZ behind RDS Proxy

- **Pros:**
  - Long-lived containers keep their pool and drain on SIGTERM; Fargate removes server management.
  - RDS Multi-AZ gives managed failover and backups; RDS Proxy absorbs connection spikes during scaling and failover.
  - Private tasks reach ECR, Secrets Manager, CloudWatch Logs and S3 through VPC endpoints, with no NAT gateway and no outbound internet path (section 1.7 of spec 008).
  - Same image and same PostgreSQL major version as locally.
- **Cons:**
  - Per-task cost is higher than equivalent EC2 capacity at scale.
  - RDS Multi-AZ failover takes longer than Aurora's.
  - RDS Proxy brings pinning rules the service must respect (ADR-0019).
  - A future call to the internet needs a NAT gateway added.

### Option B: AWS Lambda

- **Pros:**
  - No servers, scales to zero, pay per request.
- **Cons:**
  - Cold starts add latency against the 300 ms p99 target (SYS-R20).
  - Each concurrent invocation opens its own connections, so a burst becomes a connection storm on the database.
  - Graceful shutdown and an in-process pool do not fit the execution model.

### Option C: EKS (Kubernetes)

- **Pros:**
  - Portable and very flexible; rich ecosystem.
- **Cons:**
  - A cluster to run and upgrade, and operational overhead not justified for one service.

### Option D: Aurora PostgreSQL instead of RDS PostgreSQL

- **Pros:**
  - Faster failover and storage that scales automatically.
- **Cons:**
  - Costs more at this size, and its storage engine differs from the PostgreSQL run locally and in CI.

## Decision

Chosen option: **Option A**, because long-lived stateless containers fit connection pooling and graceful shutdown, Fargate removes server management, RDS Multi-AZ gives managed failover and backups, and RDS Proxy absorbs connection spikes during scaling and failover. Private tasks reach AWS services through VPC endpoints instead of a NAT gateway. Containers report liveness and the load balancer checks readiness, so a database outage never makes ECS replace every task (section 1.6 of spec 008, DEP-R21, DEP-R27). (Update 2026-10-09: phase 12-infra found that ECS replaces every task the ALB reports unhealthy, so a readiness check on the ALB would make a database outage replace every task. The owner decided that the ALB target group checks `/health/live`: while the database is down, requests answer 503 on their own, and ECS deregisters a task from the ALB before stopping it, so no readiness signal is needed to drain. The deployment circuit breaker with rollback stays; see DEP-R27 and section 1.6 of spec 008.) Lambda brings cold starts and connection storms; EKS adds operational overhead not justified for one service; Aurora PostgreSQL fails over faster but costs more, so it is the upgrade path.

The sizes and settings are those of section 1.7 of spec 008: 0.5 vCPU and 1 GB per task, 2 to 6 tasks on CPU, `stopTimeout` 40 s above the shutdown budget, `db.t4g.medium` Multi-AZ with 7-day backups and TLS required, ElastiCache Redis 7 across two zones (DEP-R30), secrets in Secrets Manager (DEP-R31), migrations as a one-off task (DEP-R28, ADR-0020) and the hourly idempotency cleanup as a scheduled task (DEP-R37).

## Consequences

### Positive

- Losing a task or an availability zone keeps the service up; the ALB routes only to ready tasks.
- No servers to patch; the database is backed up and fails over on its own.
- 6 tasks × (10 + 1) connections stay within RDS Proxy's budget (SEC-R36).

### Negative / costs

- A database failover is felt as a burst of 503s for the length of the failover, which clients retry with the same key.
- Several managed services to pay for even at low traffic (ALB, NAT-free endpoints, RDS Multi-AZ, RDS Proxy, ElastiCache).

### To monitor

- The CloudWatch alarms of section 1.8 of spec 008.
- Failover duration in practice, which decides whether Aurora is worth its cost.

### Follow-ups

- Phase 12-infra: the Terraform modules of table 1.3 of spec 008 and `docs/deployment/aws.md` with a cost estimate (DEP-R23).
