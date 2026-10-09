# ADR-0016: Error model

- **Status:** Accepted
- **Date:** 2026-10-08
- **Related specs:** 000-overview, 001-accounts, 002-ledger, 003-money-movements, 004-reversals, 005-idempotency, 006-auth, 007-security-ops, 008-deployment

## Context and problem

Clients of a money API must know what to do with an error: fix their request, give up, or retry with the same `Idempotency-Key`. Errors come from many places (the load balancer, the framework, validation, the domain, the database) and must never leak internals (AGENTS.md section 3). The question is what an error looks like and which status code means what.

## Decision drivers

- One machine-readable shape for every error, from the service and from the load balancer.
- A client can tell a bug in its request from a business refusal and from a transient failure.
- Errors that are safe to retry are marked as such.
- No stack trace, SQL or underlying message in a response (SYS-R24).
- Every error traceable to its logs through a correlation id.

## Considered options

### Option A: RFC 9457 problem details with distinct 400, 409 and 422 semantics

- **Pros:**
  - A standard format (`application/problem+json`) with `type`, `title`, `status`, `detail` and `requestId`; `type` is a stable `/problems/<slug>` a client can switch on (SYS-R24).
  - Status codes carry meaning: 400 for a malformed request, 422 for one understood and refused, 409 for a conflict with the resource's current state.
  - Validation errors list one entry per failing field with a JSON Pointer or a query parameter name (SYS-R27).
  - Transient failures (503, 429, 409 `request-in-progress`, the load balancer's 502 to 504) carry `Retry-After`, so retrying is explicit.
- **Cons:**
  - The line between 400, 409 and 422 needs rules, and every spec must follow them.
  - Every framework and load balancer default error must be overridden to keep the shape (ADR-0004, DEP-R16).

### Option B: A single 400 for every client error

- **Pros:**
  - Simplest to implement and to document.
- **Cons:**
  - Clients cannot tell a bug in their request from a business refusal, so they cannot decide whether to fix, give up or retry.

### Option C: A custom error envelope (`{"error": {"code", "message"}}`)

- **Pros:**
  - Free to shape as needed.
- **Cons:**
  - Non-standard; every client writes its own parser, and tooling (OpenAPI, client libraries) does not recognise it.

## Decision

Chosen option: **Option A**. Every error is RFC 9457 problem details with a `requestId`. 400 means the request itself is malformed (JSON that does not parse, a missing or malformed required header, an invalid cursor); 422 means it was understood and refused (validation errors with one entry per field, and money movements refused by a business rule); 409 means it conflicts with the current state of the resource it acts on (status changes, an already reversed transaction, an idempotency key still in progress). A single 400 for everything is simpler, but clients could not tell a bug in their request from a business refusal.

The rule and the catalogue are in section 1 and section 4 of spec 000 (SYS-R24 to SYS-R29), with each capability spec adding its own types. Other codes follow from the same principles: 401 with one body for every authentication failure (AUT-R06); 403 for a role not permitted, since which operations exist is public, and 404 for a resource the caller may not see, so a foreign account is indistinguishable from an unknown one (SYS-R04, SYS-R05); 413, 415 and 429 from spec 007; transient conditions answered as section 4 of spec 000 lists them (409 `/problems/request-in-progress`, 429 and 503, each with `Retry-After`), never 500 (SYS-R34); 500 `/problems/internal-error` only for a defect (SYS-R25, LED-R28); and the load balancer's own errors as `/problems/upstream-unavailable` (DEP-R16). (Update 2026-10-09, phase 14-docs: in AWS the ALB's own 502, 503 and 504 are `text/html` without a problem body, `Retry-After` or `X-Request-Id`, and AWS WAF's 429 is `application/json` without `requestId`, because neither can render problem details; clients key on the status (section 1.6 of spec 007, docs/deployment/aws.md).) A 422 `/problems/idempotency-key-reused` is a refusal of the key, not a business rule, and is not stored for replay (section 1.3 of spec 005).

## Consequences

### Positive

- One parser and one decision table for clients: fix (400, 422 validation), stop (403, 404, 422 business), retry with the same key (409 in progress, 429, 503, 502 to 504).
- Errors are safe to show and to log, and each one points to its log lines through `requestId`.

### Negative / costs

- Typed domain errors must be mapped to status and type in one place at the HTTP edge, and every new error needs a catalogue entry.
- Framework errors (malformed JSON, body too large, unsupported media type, unknown route) need explicit mapping.

### To monitor

- Tests that every error response has `application/problem+json` and no internals (SYS-AC20, SYS-AC21).
- 500 responses in production: each one is a defect.

### Follow-ups

- Phase 08-api: the error handler, the problem type registry and the OpenAPI error schemas.
  - Done in phase 08-api on 2026-10-08.
- The phase that adds nginx: problem details for its 413, 429 and gateway errors (section 1.6 of spec 007, DEP-R16).
  - Done in phase 10-runtime on 2026-10-08: the `error_page` locations of `docker/nginx/templates/default.conf.template`.
