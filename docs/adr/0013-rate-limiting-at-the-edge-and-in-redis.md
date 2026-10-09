# ADR-0013: Rate limiting at the edge and in Redis

- **Status:** Accepted
- **Date:** 2026-10-08
- **Related specs:** 000-overview, 007-security-ops, 008-deployment

## Context and problem

The service must stay responsive when a client misbehaves: a flood from one address, or one authenticated user scripting requests. Several replicas sit behind a load balancer (SYS-R16), so a limit counted in one replica's memory would let a client multiply its allowance by the number of replicas, and would change with every scale-out. The question is where requests are counted and limited, and what happens when the counter store fails.

## Decision drivers

- One count per client across every replica (SEC-R04).
- Floods stopped before they reach a replica (SEC-R01).
- Money correctness and availability never depend on the limiter (SEC-R06, SEC-R07).
- No extra write load on PostgreSQL, the only source of truth.
- One round trip per request for the per-user check.

## Considered options

### Option A: Per IP at the load balancer, per user in Redis with a fixed window, failing open

- **Pros:**
  - The per-IP limit runs in nginx locally (`limit_req` with a burst, SEC-R01) and in AWS WAF in production (a rate-based rule with a one-minute window and a limit of 60 × `RATE_LIMIT_IP_RPS`, SEC-R45), so floods never reach a replica.
  - The per-user limit needs the token, so it runs in the service right after authentication (SEC-R05), counted in Redis and shared by every replica (SEC-R04).
  - A fixed window is one atomic increment with a TTL, one round trip; `Retry-After` is the counter's remaining TTL (SEC-R03).
  - Redis is off the money path: if it is down or slow, the check fails open after `REDIS_COMMAND_TIMEOUT_MS`, the request is served, and a metric and one log line per transition record it (SEC-R06).
- **Cons:**
  - A fixed window allows up to twice the limit across a window boundary.
  - Failing open means no per-user limit while Redis is down; the per-IP limit at the edge still applies.
  - One more piece of infrastructure (Redis locally, ElastiCache in AWS, DEP-R30).
  - Locally (nginx, per second with a burst) and in AWS (WAF, per minute without a burst) the per-IP limits behave differently.

### Option B: In-memory limits in each replica

- **Pros:**
  - No dependency; fastest.
- **Cons:**
  - Breaks with several replicas: each counts separately, so the real limit is N times the configured one (SYS-R16).

### Option C: A PostgreSQL-backed limiter

- **Pros:**
  - No extra store; transactional counts.
- **Cons:**
  - Adds a write per request to the critical database, competing with money movements for connections, locks and I/O.

### Option D: A sliding window or token bucket in Redis

- **Pros:**
  - Smoother limits without the boundary burst of a fixed window.
- **Cons:**
  - More Redis work per request (sorted sets or scripts) for a precision the service does not need.

## Decision

Chosen option: **Option A**, because in-memory limits break with several replicas. nginx (AWS WAF in production, with a one-minute window) limits per IP before traffic reaches the service; the service limits per user with a fixed window in Redis, shared by all replicas, and fails open if Redis is down, because money correctness never depends on it. A PostgreSQL-backed limiter would add write load to the critical database.

Details fixed by spec 007: the per-IP limit keys on the TCP peer, never a client's `X-Forwarded-For` (SEC-R02, SEC-R19); defaults are 500 requests per second with a burst of 1000 per IP and 300 requests per 10 seconds per user (SEC-R08); every authenticated request counts, 403s and replays included (SEC-R05); both limits answer 429 problem details with `Retry-After` (SEC-R01, SEC-R03) (Update 2026-10-09, phase 14-docs: in AWS the per-IP 429 comes from WAF as `application/json` with the problem fields but no `requestId`, and `Retry-After: 60`, its window; SEC-R45, section 1.6 of spec 007); Redis holds nothing but these counters (SEC-R07); the per-user limit uses `@fastify/rate-limit` with its Redis store (docs/dependencies.md).

## Consequences

### Positive

- Limits hold across any number of replicas.
- A Redis outage never takes the API down or affects money (SEC-AC06).
- PostgreSQL carries no limiter traffic.

### Negative / costs

- Clients can burst up to twice the per-user limit around a window boundary.
- While Redis is down, only the edge limit protects the service.
- Two limiter configurations to keep consistent (nginx locally, WAF in AWS).

### To monitor

- `scf_rate_limited_total` and `scf_rate_limit_store_errors_total`.
- WAF blocked requests (the alarm of section 1.8 of spec 008) and nginx 429s in the access log.

### Follow-ups

- Phase 09-hardening: the per-user limit and the nginx configuration.
  - Done in phase 09-hardening on 2026-10-08: `src/platform/http/rate-limit.ts` and `docker/nginx/templates/default.conf.template`.
- Phase 12-infra: the WAF rate-based rule and its policy check (SEC-AC35).
  - Done in phase 12-infra on 2026-10-09: the rule `per-ip-rate-limit` in `infra/terraform/modules/edge/`, checked by `infra/policies/sec_ac35_waf_rate_limit.yaml` in the CI step `npm run infra:validate`.
