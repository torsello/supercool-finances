# 006 · Auth · Tasks

Ordered tasks for [plan.md](plan.md). Each task is under about an hour and starts with its test: write the failing test, then the code that makes it pass. A task names an acceptance criterion only when that criterion is proven once the task is done, because ticking it makes `npm run trace` require a passing test; building blocks name the requirement IDs they implement, and their tests carry those requirement IDs. Tick a task only in its own phase.

## 05-schema

No task for this spec. The cross-spec order of the 05-schema tasks is in plan 000 section 1.

## 06-domain

No task for this spec: use cases already take a caller id and role as plain values; plan 006 adds the `Caller` type that the HTTP edge builds.

## 07-idempotency

No task for this spec.

## 08-api

These tasks run in the cross-spec order of plan 000 section 1 for 08-api: authentication, error handler and pipeline, account routes, idempotency wiring, movement and reversal routes, then the ACs that need them.

- [x] Test first: AUT-AC15 in `test/unit/platform/config.test.ts`; then `JWT_SECRET`, `JWT_ISSUER` and `JWT_AUDIENCE` in `src/platform/config/config.ts`, and the two values in `.env.example` with `npm run env:sync`.
- [x] Add `test/support/tokens.ts`, signing V and its variants, and `src/modules/auth/domain/caller.ts` and `errors.ts`, with `test/unit/auth/tokens-helper.test.ts` (AUT-R02, AUT-R03) proving V decodes to the claims of the spec.
- [x] Test first in `test/unit/auth/token-verifier.test.ts` (AUT-R02, AUT-R03): the cases of the spec's valid-token and claims ACs, asserting the identity or the internal reason; then the header, signature and claims checks of `token-verifier.ts`.
- [x] Test first in `test/unit/auth/token-verifier.test.ts` (AUT-R04, AUT-R05): the expiry, not-before and lifetime cases of the spec, each with its internal reason; then the time and lifetime checks.
- [x] Test first in `test/unit/auth/token-verifier.test.ts` (AUT-R02): the signature and algorithm cases of the spec, each with its internal reason.
- [x] Test first in `test/unit/auth/permissions.test.ts` (SYS-R03, AUT-R10, AUT-R11, AUT-R14): every route of table 1.3 has exactly the roles table 1.1 of spec 000 gives it; then `permissions.ts`.
- [x] Build `authenticate.ts` and `authorize.ts` as `onRequest` hooks on every `/v1` route, with `test/integration/auth/hooks.test.ts` (AUT-R06, AUT-R20) proving a 401 carries the body and header of section 1.5 and the health check answers without reading the header.
- [x] Step 6, once `toProblem` exists (plan 000): extend the verifier tests of `test/unit/auth/token-verifier.test.ts` so every rejection is mapped by `toProblem` to 401 `/problems/unauthenticated`, and name them AUT-AC01, AUT-AC03, AUT-AC04 and AUT-AC05, as SYS-AC16 does.
- [x] Test first: AUT-AC02 in `test/integration/auth/unauthenticated.test.ts`, once `/docs` is served.
- [x] Test first: AUT-AC06 in `test/integration/auth/auth-logs.test.ts`.
- [x] Test first: AUT-AC07 and AUT-AC08 in `test/integration/auth/forbidden.test.ts`.
- [x] Test first: AUT-AC09 and AUT-AC10 in `test/integration/auth/foreign-accounts.test.ts`.
- [x] Test first: AUT-AC11 in `test/integration/auth/identity-source.test.ts`.
- [x] Test first: AUT-AC13 in `test/unit/auth/token-script.test.ts`; then `token-issuer.ts`, `src/modules/auth/adapters/cli/token.ts`, `scripts/token.ts` and `npm run token`.
- [x] Test first: AUT-AC12 in `test/integration/auth/token-script.test.ts`.
- [x] Test first: AUT-AC14 in `test/integration/auth/no-token-endpoint.test.ts`.
- [x] Update the docs: in AGENTS.md, add `npm run token` to the commands table, from 08-api.

## 09-hardening

No task for this spec: the per-user rate limit placed between authentication and the role check is built by plan 007.

## 10-runtime

No task for this spec.

## 11-e2e

- [x] Test first: AUT-AC16 in `test/e2e/authorization-matrix.test.ts`.
- [x] Update the docs: the OpenAPI bearer security scheme on every `/v1` route and the 401 and 403 responses; the README section on authentication and on minting tokens with `npm run token`; and the follow-ups closed in ADR-0012.

## 12-infra

No task for this spec.
