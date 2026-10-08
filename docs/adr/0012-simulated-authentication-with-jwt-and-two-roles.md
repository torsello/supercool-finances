# ADR-0012: Simulated authentication with JWT and two roles

- **Status:** Accepted
- **Date:** 2026-10-08
- **Related specs:** 000-overview, 001-accounts, 005-idempotency, 006-auth, 007-security-ops, 008-deployment

## Context and problem

Every request except the health checks and the documentation acts for one user with one role (SYS-R01). The challenge allows authentication to be simulated (docs/challenge.md), but the service still needs a real, strict verification path: ownership, authorization, the idempotency key scope and audit records all hang off the caller's identity (AUT-R07). Spec 006 also asks for the production design to be recorded, including how an OpenID Connect provider whose subjects are not UUIDs would map to the service's user ids. The question is how callers are authenticated now and how that changes in production.

## Decision drivers

- Strict, stateless verification that every replica applies identically (AUT-R21, SYS-R16).
- No credentials or login flow to build, as the challenge allows.
- No token issuing in the API (AUT-R15).
- A clean upgrade path to a real identity provider without changing how the rest of the service sees a user.
- User ids stay UUIDs (AUT-R03), since accounts, idempotency keys and audit records store them.

## Considered options

### Option A: HS256 JWTs with a shared secret, minted by a CLI script

- **Pros:**
  - No identity infrastructure: `npm run token -- --sub <id> --role <role>` mints a token (AUT-R16).
  - Standard format: the same verification shape (claims, lifetime, issuer, audience) as tokens from an OIDC provider, so the production change is the key source, not the claims.
  - Stateless: each replica verifies from the token and configuration alone (AUT-R21).
- **Cons:**
  - The verifier holds the signing secret, so anyone with `JWT_SECRET` can mint any identity and any role; that is acceptable only while minting is a developer tool.
  - No revocation: a token lives until it expires (at most 15 minutes).
  - Rotating the secret needs a restart (out of scope in spec 006).

### Option B: An external OIDC provider from the start (RS256 or ES256, keys through JWKS)

- **Pros:**
  - Production-grade: asymmetric keys, so the service can verify but never mint; key rotation through JWKS.
- **Cons:**
  - Needs a provider to run locally and in CI (for example a container), with users to manage, and adds JWKS fetching and caching to every replica.
  - Out of scope for the challenge (section 6 of spec 006).

### Option C: Opaque session tokens or API keys stored in the database

- **Pros:**
  - Revocable at once.
- **Cons:**
  - A database read on every request, a login or issuing flow to build, and a session table to manage.

## Decision

Chosen option: **Option A** now, with **Option B** as the production design. The challenge allows simulating authentication. Tokens are HS256 with the algorithm pinned, a secret of at least 32 bytes, and `sub`, `role`, `iss`, `aud` and an `exp` at most 15 minutes after `iat`, minted by a CLI script; the API never issues tokens, and every failure answers the same 401. Roles are `customer` and `operator`, one per identity.

The details are those of spec 006: `alg` exactly `HS256`, never a key named or embedded in the header, and `crit` refused (AUT-R02); `sub` a UUID, `role` exactly `customer` or `operator`, `iss` and `aud` equal to the configured values (AUT-R03); a fixed 5-second clock tolerance and a lifetime of at most 900 seconds (AUT-R04, AUT-R05); credentials only from the `Authorization` header (AUT-R01); one 401 body and `WWW-Authenticate` header for every failure, with the failed check only in a `warn` log line (AUT-R06, AUT-R19); 403 for a role not permitted and 404 for another customer's account (AUT-R10 to AUT-R12). One identity per role is a rule for whoever mints tokens, not enforced by the service without a user registry; that risk is accepted in section 1.1 of spec 006.

**Production.** Tokens come from an external OIDC provider, signed with asymmetric keys (RS256 or ES256) and verified through its JWKS, with key rotation by the provider and the algorithm still pinned; internal service-to-service traffic, if any is added, uses mTLS. The service keeps UUID user ids (AUT-R03), so a provider whose subjects are not UUIDs needs a mapping: a users table from (issuer, subject) to a UUIDv7 created the first time the subject is seen. A UUIDv5 derived from issuer and subject was considered: stateless, but it ties every id to one provider forever, so moving to another provider would change every user id.

## Consequences

### Positive

- Every replica authenticates identically with no shared state.
- The rest of the service sees only a lowercase UUID and a role; moving to OIDC changes the verifier and adds the mapping table, nothing else.
- Failure answers reveal nothing about which check failed.

### Negative / costs

- `JWT_SECRET` is a master key: whoever has it can act as any user. It lives in Secrets Manager in AWS (DEP-R31), the demo value is refused in production (DEP-R07), and it is redacted from logs (SEC-R22).
- No revocation before expiry.
- The production mapping table, once added, becomes part of every request's path (a lookup per token, or a cache that must not break SYS-R16).

### To monitor

- 401 rate by reason code (AUT-R19): a spike in `signature` or `algorithm` suggests forged tokens.
- Any request processed with both roles for one `sub` in audit records, which would show the minting rule being broken.

### Follow-ups

- Phase 08-api: the verifier and the token script.
- When a provider is chosen: a new ADR for the provider, JWKS caching and the (issuer, subject) mapping table, superseding the HS256 part of this one.
