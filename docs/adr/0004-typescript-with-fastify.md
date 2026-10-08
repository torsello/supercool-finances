# ADR-0004: TypeScript with Fastify

- **Status:** Accepted
- **Date:** 2026-10-07
- **Related specs:** 000-overview, 003-money-movements, 005-idempotency, 006-auth, 007-security-ops

## Context and problem

The service is an HTTP JSON API in Node.js 24 written in strict TypeScript (AGENTS.md section 4). Every input must pass a strict schema (AGENTS.md section 3), every error must be a problem details body (SYS-R24, SYS-R27), requests are checked in a fixed order (SYS-R31), and the service needs hooks for authentication, rate limiting, body limits, timeouts and graceful shutdown (spec 007). The question is which HTTP framework to build on.

## Decision drivers

- Strict request validation and response serialization from one schema definition, also used to generate OpenAPI.
- Async handlers whose rejected promises reach one error handler.
- Control over the order of request processing (SYS-R31): route, authentication, rate limit, role, media type, body size, parsing, idempotency, validation.
- First-class TypeScript, without `any` leaking into handlers.
- Performance headroom for the load test target (SYS-R20).
- A small, explicit framework that hides no control flow.

## Considered options

### Option A: Fastify

- **Pros:**
  - Schema-based validation and serialization per route; with `fastify-type-provider-zod`, Zod schemas give validation, typed handlers and the OpenAPI document (`@fastify/swagger`) from one definition.
  - Encapsulated plugins: hooks and decorators scoped to a set of routes, which matches modules and makes the test app's seams (SYS-R37) easy to register only in tests.
  - Async handlers and a single `setErrorHandler`, where typed errors map to `application/problem+json`.
  - Lifecycle hooks (`onRequest`, `preHandler`, ...) to place each check of SYS-R31 explicitly; built-in body limit, content-type parsing, request id and `pino` logging with redaction (SEC-R22).
  - Good performance, and `app.inject()` for fast HTTP-level integration tests without a socket.
  - Maintained plugins for the needs of spec 007 (`@fastify/helmet`, `@fastify/rate-limit` with a Redis store, `@fastify/cors`).
- **Cons:**
  - Its lifecycle and encapsulation rules are a learning curve; a hook registered in the wrong scope silently does not run.
  - Fastify's own validation errors must be translated to the `errors` shape of SYS-R27.
  - Smaller ecosystem than Express.

### Option B: Express

- **Pros:**
  - The most widely known Node framework, with the largest middleware ecosystem.
- **Cons:**
  - No built-in validation or serialization; schemas, OpenAPI and typing must be assembled from separate libraries.
  - Async error handling is weaker: only Express 5 forwards rejected promises, and much middleware still assumes callbacks.
  - Slower, and no request encapsulation model.

### Option C: NestJS

- **Pros:**
  - A complete framework: dependency injection, modules, guards, pipes and interceptors out of the box; can run on Fastify.
- **Cons:**
  - Heavy and decorator-based; control flow (which guard, pipe and interceptor runs when) is hidden in metadata, while this service wants the order of checks (SYS-R31) and the transaction boundary explicit (ADR-0003).
  - Its module and DI system overlaps with, and pulls against, the hexagonal structure chosen in ADR-0003.
  - More dependencies and more framework surface to audit.

## Decision

Chosen option: **Option A**, because Fastify gives schema-based validation and serialization, encapsulated plugins, good performance and first-class TypeScript. Express lacks built-in validation and async error handling; NestJS adds a heavy decorator-based framework that hides control flow this service wants explicit.

Fastify lives only in the HTTP adapters and the composition root (`src/app.ts`); the domain never imports it (ADR-0003).

Fastify validates the route schema before the handler runs, but SYS-R31, IDM-R06 and IDM-R08 put the idempotent replay before validation, so a replay must never get a 422. The design reconciles them this way:

- Route schemas never decide the order of checks. Every route registers its Zod schemas with `attachValidation`, so a schema error is answered only at the validation step of SYS-R31: after the replay on routes that take a key, inside the database transaction after the savepoint (steps 4 and 5 of section 1.1 of spec 005).
- Path ids, the `Idempotency-Key` header and the pagination cursor are plain strings in those schemas and are checked at their own steps: a path id that is not a UUID answers 404 at lookup (SYS-R42), and a malformed key or cursor answers 400 at the malformed-request step (SYS-R26, IDM-R03).
- The idempotency fingerprint (IDM-R05) is computed at step 2 of section 1.1 of spec 005 from the request as received: the method, the raw path and the JSON body as parsed, captured before the validation step can replace `request.body` (for example in a `preValidation` hook), never from the Zod output. Schemas may transform values for the use case, but a transformed value never feeds the fingerprint. Two failures follow otherwise: a `bigint` produced by a transform cannot be canonicalized, so every valid keyed movement would fail; and an id lowercased by a transform (MOV-R30) would let two different bodies share a fingerprint, so the second would replay the first's response instead of answering 422 `idempotency-key-reused` (IDM-R05, IDM-R09).
- Apart from the fingerprint, the handler uses the body only after the validation check.

## Consequences

### Positive

- One Zod schema per route validates input, types the handler and documents the endpoint.
- The order of SYS-R31 maps to named hooks and is testable through `app.inject()`.
- All errors pass through one handler that produces problem details without internals (SYS-R24).

### Negative / costs

- Fastify's default error and 404 bodies must be overridden everywhere so every error, including framework ones (body too large, unsupported media type, malformed JSON), is a problem details body.
- Plugin scope mistakes are easy to make and must be covered by tests of the order of checks (SYS-AC23).
- Routes give up Fastify's automatic validation: the handler must check the attached validation error itself, at the validation step, and until then the body's type is a promise the runtime has not kept. A handler that reads the body before that check, or forgets the check, breaks the order of SYS-R31.

### To monitor

- Tests of SYS-AC20, SYS-AC21 and SYS-AC23: any framework error that escapes as non-problem JSON.
- Fastify major releases and plugin compatibility (`fastify-type-provider-zod` with Zod 4).

### Follow-ups

- Phase 08-api builds the error handler, the hooks in the order of SYS-R31 and the OpenAPI document, and registers every route with `attachValidation`, answering a schema error at the validation step of SYS-R31 (after the replay step and the savepoint on routes that take a key), with tests that a replay of a request that would now fail validation still gets its stored response.
