# ADR-0023: Optional observability: Prometheus and Grafana locally, a Sentry-compatible error reporter, both off by default

- **Status:** Accepted
- **Date:** 2026-10-09
- **Related specs:** 007-security-ops, 008-deployment

## Context and problem

Each replica already serves Prometheus metrics on `METRICS_PORT` (SEC-R41, table 1.4 of spec 007) and writes JSON logs with a correlation id (SEC-R21), but nothing reads them locally: the metrics port is never published (SEC-R43), so watching the stack means `docker compose exec api-1 wget` against one replica at a time. In AWS the alarms use the metrics AWS publishes, and scraping the service's own metrics is a documented next step (an ADOT collector writing to Amazon Managed Service for Prometheus, `docs/deployment/aws.md`). An unexpected error, a 500, is logged at `error` and nothing else: no grouping, no count of how often it happens, no alert.

The owner asked for an optional add-on that makes the metrics visible locally and reports unexpected errors, without changing what `docker compose up` starts or what the demo and the tests need. The questions are: which tools show the metrics, which kind of tool receives the errors, and whether either is on by default.

## Decision drivers

- No change to the default stack: `docker compose up` starts and publishes exactly what DEP-AC01 lists, and the demo and the tests need no key, account or network access.
- No customer data leaves the deployment: no amount, account or transaction id, token, secret, header or body in anything sent out (SEC-R22, AGENTS.md §3).
- `METRICS_PORT` stays internal (SEC-R43).
- Reuse what the service already exposes: the Prometheus metrics of table 1.4 and the 500s of SYS-R25.
- Every image pinned by version and digest (DEP-R22); few new dependencies.
- Nothing on the money path: observability can fail without changing an answer.

## Considered options

### Option A: A Compose profile with Prometheus and Grafana, and an opt-in Sentry-compatible error reporter, both off by default

- **Pros:**
  - Prometheus reads the existing `/metrics` with no code change, scraping both replicas inside the compose network, so `METRICS_PORT` stays unpublished.
  - Grafana is the usual viewer for Prometheus; a provisioned, read-only dashboard shows requests, latency percentiles, movements, lock timeouts, replays, rate limits and pool usage for the load test or a replica failover (spec 008 section 1.9).
  - Both are open source, run offline from pinned images, and are opt-in through a Compose profile that `up` never starts.
  - Error reporting targets the Sentry envelope protocol, which Sentry's SaaS, self-hosted Sentry and GlitchTip all accept, so the errors can stay on infrastructure the operator controls.
  - Error trackers are built for this job: unexpected exceptions with stack traces, grouped into issues, counted and alerted on.
  - An event built from an allowlist (section 1.10 of spec 007) sends the correlation id and the route, which lead to the full log lines, and nothing else.
- **Cons:**
  - Two more images to pin and update, and a few hundred MB to pull the first time the profile runs.
  - The local Prometheus is not what AWS would use (ADOT and Amazon Managed Service for Prometheus), so the dashboard is a local tool, not the production one.
  - The allowlist and the message scrub are code to maintain, and a stack trace and a scrubbed message are less than a full SDK event would hold.
  - In AWS the tasks have no outbound internet path, so error reporting needs a NAT gateway with an egress allow-list before it can be turned on there.

### Option B: A product-analytics tool such as PostHog for errors and usage

- **Pros:**
  - One tool for usage analytics, feature flags and, through its exception capture, errors.
  - Self-hostable.
- **Cons:**
  - Product analytics is built around identified users and their actions (a `distinct_id` per person, events per action). For a money service that means sending customer behaviour and identifiers to an analytics store, the opposite of data minimisation, and with no product decision here that needs it: the service is an API with no user interface to analyse.
  - Its error tracking is secondary to its analytics, with less grouping and alerting than a dedicated error tracker.
  - It would add a second channel for customer data that needs its own review, retention and access rules.

### Option C: Observability always on in the default stack

- **Pros:**
  - Nobody has to know about a profile; the dashboard is always there.
- **Cons:**
  - `docker compose up` would start two more containers and publish one more port, changing DEP-AC01 and the e2e suite's port check, and costing memory and start time on every run.
  - An error reporter that is on by default needs a DSN, so the demo and the tests would need an account or a running Sentry-compatible server.
  - Data would leave the machine without anyone asking for it.

### Option D: Keep logs and `/metrics` only

- **Pros:**
  - Nothing to add or maintain.
- **Cons:**
  - The metrics stay unread locally, and the 500s stay lines in a log, ungrouped and without alerts.

### Sub-decision: how the service sends reports (open question Q1 of spec 007)

- **Its own client, writing Sentry envelopes with Node's `fetch`:** no new dependency; every byte sent is written by the allowlist, so no SDK default can add a header, a body or a breadcrumb. It costs about 150 lines (DSN parsing, the envelope, stack frames, the bounded queue of SEC-R54) and does not honour the server's rate-limit headers beyond those bounds.
- **The official SDK `@sentry/node` 11.6:** maintained by Sentry, with its transport, retries and the server's rate limits handled. It installs 18 packages and 82 MB, and by default instruments `http`, `pg` and Fastify through OpenTelemetry and records request data and breadcrumbs, so each default integration must be turned off and every event rebuilt from the allowlist in `beforeSend`. Its size also enlarges the runtime image that `trivy image` scans.

The owner chose the service's own client on Node's `fetch`, with no new dependency, on 2026-10-09.

## Decision

Chosen option: **Option A**, approved by the owner on 2026-10-09, because it reuses what the service already exposes and changes nothing by default.

- **Prometheus and Grafana, locally.** The metrics are already in the Prometheus format, so Prometheus scrapes them unchanged and Grafana shows them; both run offline from pinned images inside the compose network, so `METRICS_PORT` stays internal. They are local because the AWS deployment has no metrics backend of its own yet: its alarms use AWS's metrics, and scraping in AWS stays the ADOT and Amazon Managed Service for Prometheus step of `docs/deployment/aws.md`.
- **A Sentry-compatible error reporter, not product analytics.** An unexpected 500 needs an error tracker: a stack trace, grouping and alerts, linked to the logs by the correlation id. A product-analytics tool such as PostHog is built to follow identified users and their actions, which for a money service means sending customer behaviour and identifiers out, with no need for it. The Sentry protocol is open and self-hostable, and only an allowlisted, scrubbed event is sent.
- **The service's own reporter.** It writes Sentry envelopes with Node's `fetch` and adds no dependency, so every byte it sends comes from the allowlist; it sends the scrubbed message, and reports only requests answered 500, never an error outside a request (Q1 to Q3 of spec 007). A `SENTRY_DSN` must use `https://`, except for a loopback host (`127.0.0.1`, `[::1]` or `localhost`) such as the tests' fake endpoint.
- **Both off by default.** `docker compose up` stays exactly as DEP-AC01 states, the demo and the tests need no key or network, and no data leaves the machine unless the operator asks for it: the profile with `--profile observability` or `make observability`, error reporting by setting `SENTRY_DSN`, which `compose.yaml` never passes: the override `compose.error-reporting.yaml` adds it to the replicas as `${SENTRY_DSN:?...}` and refuses to start without one. Prometheus publishes no port; Grafana's panel "Replicas scraped" shows its targets.

## Consequences

### Positive

- The load test and a replica failover can be watched live, per replica.
- Unexpected errors are grouped and counted where a reporter is configured, each linked to its log lines by the correlation id.
- The default stack, its ports, the tests and AWS are unchanged.

### Negative / costs

- Two more pinned images for Dependabot to update, and a dashboard JSON to keep in step with table 1.4 (DEP-AC32 fails when a panel names a metric the service does not register).
- The e2e suite starts the profile once (DEP-AC33), which pulls two images in CI; it removes them when it ends, never running beside the load test on CI's 2-CPU runner, and the suite checks that port 3030 is free before it starts.
- The error-reporting allowlist and scrub are code to maintain, and a scrubbed message can hide a value that would have helped a diagnosis.
- Error reporting cannot run in AWS until an egress path exists.

### To monitor

- Locally, the dashboard during `npm run load`: the 5xx share, p99 latency against the 300 ms of SYS-R20, and pool waits.
- Where a DSN is set, the `warn` line saying error reporting is failing (SEC-R54), and the number of reports against the 500s in the logs.

### Follow-ups

- Phase 12b-observability: the profile, its configuration and dashboard, and DEP-AC31 to DEP-AC33 (plan 008).
  - Done in phase 12b-observability on 2026-10-09: `prometheus` and `grafana` in `compose.yaml`, `docker/prometheus/`, `docker/grafana/` and `make observability`, proven by DEP-AC31, DEP-AC32 and DEP-AC33.
- Phase 12b-observability: the error reporter and SEC-AC40 to SEC-AC46 (plan 007), and the override `compose.error-reporting.yaml` with DEP-AC34 (plan 008).
  - Done in phase 12b-observability on 2026-10-09: `src/platform/error-reporting/` and its call from `logFailure`, proven by SEC-AC40 to SEC-AC46, and `compose.error-reporting.yaml`, proven by DEP-AC34.
- Later, outside this repository: in AWS, an ADOT collector and Amazon Managed Service for Prometheus with Amazon Managed Grafana; and, for error reporting, a NAT gateway with an egress allow-list and the DSN as a Secrets Manager secret.
