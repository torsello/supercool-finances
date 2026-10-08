# 006 · Authentication and authorization

- **Status:** Approved
- **ID prefix:** AUT
- **Related ADRs:** [ADR-0001](../../docs/adr/0001-spec-driven-development-with-adrs-and-ai-agents.md), [ADR-0004](../../docs/adr/0004-typescript-with-fastify.md), [ADR-0005](../../docs/adr/0005-postgresql-as-the-only-source-of-truth.md), [ADR-0012](../../docs/adr/0012-simulated-authentication-with-jwt-and-two-roles.md), [ADR-0016](../../docs/adr/0016-error-model.md)
- **Depends on specs:** 000-overview, 001-accounts, 003-money-movements, 004-reversals, 005-idempotency, 007-security-ops

## 1. Context and goal

Every request to the service, except the health checks and the API documentation, acts for one user with one role (SYS-R01). The challenge allows authentication to be simulated (docs/challenge.md), so this version verifies bearer JWTs signed with HS256 and a shared secret from the environment, and the only way to get a token is a local CLI script. The API has no login and no endpoint that issues tokens. In production the tokens would come from an external OpenID Connect provider, signed with an asymmetric key (RS256 or ES256) and verified through its JWKS; that is out of scope here and is recorded in [ADR-0012](../../docs/adr/0012-simulated-authentication-with-jwt-and-two-roles.md).

This spec defines what a valid token is, how the caller's identity and role are taken from it and from nowhere else, what a request with no valid token answers, and which role may do what on whose account, written once as the authorization matrix of section 1.3. Terms have the meanings in the glossary of spec 000.

### 1.1 Token

A token is a compact JWS (three base64url segments) sent as `Authorization: Bearer <token>`.

| Part                       | Rule                                                                                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Header `alg`               | Exactly `HS256`. Any other value, `none` included, is rejected.                                                                                                             |
| Signature                  | HMAC-SHA256 with `JWT_SECRET`, never with a key named or embedded in the token header (`kid`, `jwk`, `jku`, `x5u`, `x5c`).                                                  |
| `sub`                      | The user id: a UUID in any letter case, used in canonical lowercase form.                                                                                                   |
| `role`                     | Exactly `customer` or `operator`.                                                                                                                                           |
| `iat`                      | Issued-at time, a NumericDate (seconds since the epoch). Not more than 5 seconds in the future.                                                                             |
| `exp`                      | Expiry time, a NumericDate. The token is rejected from `exp` + 5 seconds on, and `exp` − `iat` is greater than 0 and at most 900 seconds (15 minutes).                      |
| `nbf` (optional)           | Not-before time. When present, not more than 5 seconds in the future.                                                                                                       |
| `iss`                      | Equal to `JWT_ISSUER`.                                                                                                                                                      |
| `aud`                      | Equal to `JWT_AUDIENCE`, or an array that contains it, as RFC 7519 allows.                                                                                                  |
| Other claims, `typ`, `kid` | Ignored, so a token from an OIDC provider with extra claims still verifies. A `crit` header parameter is rejected, because the service understands no extension (RFC 7515). |

The tolerance of 5 seconds on `exp`, `iat` and `nbf` is fixed in code and not configurable: replicas and the token script share the host clock locally and NTP in AWS, so a larger window would only extend the life of a stolen token. No tolerance applies to the 900-second lifetime. `nbf` is accepted because OpenID Connect providers may send it. The service does not prevent one `sub` from appearing with both roles: without a user registry the role comes only from the token, and minting a token requires `JWT_SECRET`. One identity per role (section 1.1 of spec 000) is a rule for whoever mints tokens, enforced by the identity provider in production; this is an accepted risk.

### 1.2 Token CLI

`npm run token -- --sub <id> --role <role>` prints one token for that user and role, signed with the configuration of the environment it runs in: `iat` is the current time, `exp` is `iat` + 900, `aud` is a string and `nbf` is never set. It takes no `--ttl` or other lifetime option; tests that need expired or otherwise different tokens sign them with a test helper and the test secret. It reads `JWT_SECRET`, `JWT_ISSUER` and `JWT_AUDIENCE` through the service's configuration loader, from the same environment (and `.env`, when the service loads it), and applies the checks of AUT-R18, so it signs only tokens the service accepts. It is a developer and demo tool; it never runs inside the service and the service never calls it.

### 1.3 Authorization matrix

Every route that requires authentication, by role and by whose account the request acts on. **Own** means the account in the path belongs to the calling customer; for a transfer it is the source in the path, and for a transaction it is a transaction with an entry on one of the caller's accounts. **Foreign** means the account belongs to another customer, or the transaction has entries only on other customers' accounts (and system accounts). Operators own no accounts, so they have one column, for any customer account or transaction. A cell marked "—" does not exist, because the route names no account. Paths are written without the `/v1` prefix under which every endpoint is served (SYS-R43): M03, for example, is served as `GET /v1/accounts/{id}`. A cell gives the status and, for an error, its problem type; every error cell changes nothing. System accounts, unknown ids and ids that are not UUIDs answer as specs 000, 001 and 003 define, and are not cells of this table.

| #   | Endpoint                                             | No valid token                  | Customer · own                        | Customer · foreign        | Operator                  |
| --- | ---------------------------------------------------- | ------------------------------- | ------------------------------------- | ------------------------- | ------------------------- |
| M01 | `POST /accounts`                                     | 401 `/problems/unauthenticated` | 201, account owned by the caller      | —                         | 403 `/problems/forbidden` |
| M02 | `GET /accounts`                                      | 401 `/problems/unauthenticated` | 200, only the caller's accounts       | —                         | 403 `/problems/forbidden` |
| M03 | `GET /accounts/{id}`                                 | 401 `/problems/unauthenticated` | 200                                   | 404 `/problems/not-found` | 200, with `ownerId`       |
| M04 | `GET /accounts/{id}/entries`                         | 401 `/problems/unauthenticated` | 200                                   | 404 `/problems/not-found` | 200                       |
| M05 | `POST /accounts/{id}/freeze`                         | 401 `/problems/unauthenticated` | 403 `/problems/forbidden`             | 403 `/problems/forbidden` | 200                       |
| M06 | `POST /accounts/{id}/unfreeze`                       | 401 `/problems/unauthenticated` | 403 `/problems/forbidden`             | 403 `/problems/forbidden` | 200                       |
| M07 | `POST /accounts/{id}/close`                          | 401 `/problems/unauthenticated` | 403 `/problems/forbidden`             | 403 `/problems/forbidden` | 200                       |
| M08 | `POST /accounts/{id}/deposits`                       | 401 `/problems/unauthenticated` | 403 `/problems/forbidden`             | 403 `/problems/forbidden` | 201                       |
| M09 | `POST /accounts/{id}/withdrawals`                    | 401 `/problems/unauthenticated` | 201                                   | 404 `/problems/not-found` | 403 `/problems/forbidden` |
| M10 | `POST /accounts/{id}/transfers`, to an own account   | 401 `/problems/unauthenticated` | 201                                   | 404 `/problems/not-found` | 403 `/problems/forbidden` |
| M11 | `POST /accounts/{id}/transfers`, to another customer | 401 `/problems/unauthenticated` | 201                                   | 404 `/problems/not-found` | 403 `/problems/forbidden` |
| M12 | `GET /transactions/{id}`                             | 401 `/problems/unauthenticated` | 200, only the entries of own accounts | 404 `/problems/not-found` | 200, every entry          |
| M13 | `POST /transactions/{id}/reversals`                  | 401 `/problems/unauthenticated` | 403 `/problems/forbidden`             | 403 `/problems/forbidden` | 201                       |

The table has 50 cells: 13 rows of "No valid token", 13 of "Customer · own", 11 of "Customer · foreign" and 13 of "Operator". The health checks and the API documentation require no token and are not in the table (AUT-R20).

### 1.4 Configuration

| Variable       | Rule                                                                                                                                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_SECRET`   | Required. At least 32 bytes in UTF-8 (256 bits, the HS256 output size, RFC 7518 section 3.2), used as given, never decoded from base64. This also refuses the `change-me` placeholder of `.env.example`. |
| `JWT_ISSUER`   | Required, not empty, no default in code. `.env.example` sets `supercool-finances-local`.                                                                                                                 |
| `JWT_AUDIENCE` | Required, not empty, no default in code. `.env.example` sets `supercool-finances-api`.                                                                                                                   |

`npm run env:sync` adds the variables to an existing `.env`. Tests set their own values.

### 1.5 The 401 answer

Every 401 carries the header `WWW-Authenticate: Bearer realm="supercool-finances"`, with no `error` parameter, because one would tell a missing token from a bad one (RFC 6750 allows it). Its body has `type` `/problems/unauthenticated`, `title` "Unauthenticated", `status` 401, `detail` "A valid bearer token is required." and `requestId`. A token sent only in the query string (`access_token`, RFC 6750 section 2.3) is never read, because query strings reach access logs and browser history; such a request answers 401 as one without credentials.

## 2. Requirements

| ID      | Requirement (EARS)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AUT-R01 | THE SYSTEM SHALL read credentials only from the `Authorization` header, in the form `Bearer` (the scheme name in any letter case, RFC 7235), one space and a compact JWS, and never from the query string (including `access_token`), the body, a cookie or any other header (section 1.5).                                                                                                                                                                                                                     |
| AUT-R02 | THE SYSTEM SHALL accept a token only if its protected header has `alg` exactly `HS256`, carries no `crit` parameter, and its signature verifies with `JWT_SECRET`, never with a key named or embedded in the token header (`kid`, `jwk`, `jku`, `x5u`, `x5c`) (section 1.1).                                                                                                                                                                                                                                    |
| AUT-R03 | THE SYSTEM SHALL accept a token only if its claims hold a `sub` that is a UUID, a `role` that is exactly `customer` or `operator`, numeric `iat` and `exp`, an `iss` equal to `JWT_ISSUER`, and an `aud` equal to `JWT_AUDIENCE` or an array containing it (sections 1.1 and 1.4).                                                                                                                                                                                                                              |
| AUT-R04 | THE SYSTEM SHALL accept a token only while the current time is earlier than `exp` + 5 seconds, `iat` is not later than the current time + 5 seconds, and `nbf`, when present, is not later than the current time + 5 seconds (section 1.1).                                                                                                                                                                                                                                                                     |
| AUT-R05 | THE SYSTEM SHALL accept a token only if `exp` − `iat` is greater than 0 and at most 900 seconds.                                                                                                                                                                                                                                                                                                                                                                                                                |
| AUT-R06 | IF a request to a route that requires authentication has no `Authorization` header, a header that is not one Bearer credential, or a token that fails any check of AUT-R02 to AUT-R05, THEN THE SYSTEM SHALL answer 401 with problem type `/problems/unauthenticated`, a body whose members are identical in every case except `requestId`, and the `WWW-Authenticate` header and body of section 1.5 in every case, and change nothing (SYS-R02).                                                              |
| AUT-R07 | WHEN a token is accepted THE SYSTEM SHALL identify the caller as the user whose id is the token's `sub` in canonical lowercase form, with the token's `role`, and use only that identity and role for ownership, authorization, the idempotency key scope (IDM-R04) and audit records.                                                                                                                                                                                                                          |
| AUT-R08 | THE SYSTEM SHALL never take the caller's user id or role from the request body, the query string, or any header other than `Authorization`, such as `X-User-Id`.                                                                                                                                                                                                                                                                                                                                                |
| AUT-R09 | IF a request body or query string contains a member that the endpoint does not define, such as `ownerId`, `userId`, `sub` or `role`, THEN THE SYSTEM SHALL answer 422 with problem type `/problems/validation-error` and an `errors` entry for that member, which for a query string parameter is `{"parameter": "<name>", "detail": "..."}` in place of the `pointer` of a body member (SYS-R27), and change nothing (SYS-R27); an idempotent replay is answered before the query string is checked (SYS-R33). |
| AUT-R10 | IF a customer requests an operator-only operation (deposit, freeze, unfreeze, close or reversal) THEN THE SYSTEM SHALL answer 403 with problem type `/problems/forbidden`, with bodies that differ only in `requestId` whatever id the path names, and change nothing (SYS-R04, SYS-R31).                                                                                                                                                                                                                       |
| AUT-R11 | IF an operator requests a customer-only operation (create an account, list accounts, withdrawal or transfer) THEN THE SYSTEM SHALL answer 403 with problem type `/problems/forbidden`, with bodies that differ only in `requestId` whatever id the path names, and change nothing (SYS-R04).                                                                                                                                                                                                                    |
| AUT-R12 | IF a customer reads, lists the history of, withdraws from or transfers out of an account owned by another customer, THEN THE SYSTEM SHALL answer 404 with problem type `/problems/not-found`, with the body it gives for an account id that does not exist except for `requestId`, and change nothing (SYS-R05).                                                                                                                                                                                                |
| AUT-R13 | WHEN a customer transfers out of their own account THE SYSTEM SHALL accept as destination an account of any customer, and answer every destination the sender cannot credit as spec 003 defines (MOV-R03, MOV-R15, SYS-R41).                                                                                                                                                                                                                                                                                    |
| AUT-R14 | THE SYSTEM SHALL answer every cell of the authorization matrix of section 1.3 with the status and problem type that the cell states.                                                                                                                                                                                                                                                                                                                                                                            |
| AUT-R15 | THE SYSTEM SHALL expose no endpoint that issues, refreshes or exchanges tokens.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| AUT-R16 | WHEN `npm run token -- --sub <id> --role <role>` runs with a UUID `<id>`, a `<role>` of `customer` or `operator` and a valid configuration, THE SYSTEM SHALL print on stdout exactly one line holding one token with header `alg` `HS256` and `typ` `JWT`, claims `sub` (the id in canonical lowercase), `role`, `iat` (the current time), `exp` (`iat` + 900), `iss` (`JWT_ISSUER`) and `aud` (`JWT_AUDIENCE`), signed with `JWT_SECRET`, and exit with code 0 (section 1.2).                                  |
| AUT-R17 | IF the token script gets no `--sub`, a `--sub` that is not a UUID, no `--role`, a `--role` other than `customer` or `operator`, an argument it does not define, or a configuration that AUT-R18 refuses, THEN THE SYSTEM SHALL print nothing on stdout, print a message naming the problem on stderr, and exit with a non-zero code.                                                                                                                                                                            |
| AUT-R18 | IF `JWT_SECRET` is unset or shorter than 32 bytes in UTF-8, or `JWT_ISSUER` or `JWT_AUDIENCE` is unset or empty, THEN THE SYSTEM SHALL refuse to start, with an error that names the variable and never contains its value (section 1.4).                                                                                                                                                                                                                                                                       |
| AUT-R19 | THE SYSTEM SHALL never write a token, the value of an `Authorization` header or `JWT_SECRET` to a log line, a problem details body, an audit record or the token script's stderr; and WHEN it answers 401 THE SYSTEM SHALL write one log line at level `warn` with the correlation id and a reason code naming the check that failed, one of `missing`, `malformed`, `algorithm`, `signature`, `expired`, `not_yet_valid`, `lifetime` and `claims`, and never the token or any claim value.                     |
| AUT-R20 | WHEN a request reaches a health check or the API documentation THE SYSTEM SHALL answer it without reading the `Authorization` header, so that an absent, valid or invalid token gives the same answer (SYS-R01).                                                                                                                                                                                                                                                                                                |
| AUT-R21 | THE SYSTEM SHALL verify each token from the token and the configuration alone, with no session, cache of verified tokens or revocation list in process memory, so that every replica accepts and rejects the same tokens (SYS-R16).                                                                                                                                                                                                                                                                             |

## 3. Acceptance criteria

Unless stated otherwise: customer user C1 owns account A1 (EUR), customer user C2 owns account B1 (EUR), and O1 is an operator user. In unit ACs and AUT-AC12 their ids are fixed: C1 is `0192f0a0-0000-7000-8000-0000000000c1`, C2 is `0192f0a0-0000-7000-8000-0000000000c2` and O1 is `0192f0a0-0000-7000-8000-0000000000f1`. Every other AC mints fresh subjects, new UUIDs, for C1, C2 and O1, so that on the shared test database they own only the accounts the AC creates; U is an account id that does not exist; balances are set up by deposits from O1; every deposit, withdrawal, transfer and reversal carries a fresh Idempotency-Key. The service runs with `JWT_ISSUER` "scf-test", `JWT_AUDIENCE` "scf-api" and `JWT_SECRET` K, a 48-byte test value; K2 is another 48-byte value. In unit ACs the verifier's clock is injected and reads T = 1791374400 (2026-10-07T12:00:00Z). V is the reference token: header `{"alg": "HS256", "typ": "JWT"}`, claims `{"sub": C1, "role": "customer", "iat": T − 60, "exp": T + 840, "iss": "scf-test", "aud": "scf-api"}`, signed with K. "A variant of V" changes only what the AC names and is signed with K unless stated otherwise. In integration and e2e ACs, T is the current time when the token is made.

### AUT-AC01 · A valid token identifies the caller

- **Level:** unit
- **Covers:** AUT-R03, AUT-R07
- **Given** the token verifier with the configuration and clock above
- **When** it verifies V; a variant of V with `sub` O1 and `role` "operator"; a variant of V with `sub` "0192F0A0-0000-7000-8000-0000000000C1" in uppercase; a variant of V with `aud` `["other-api", "scf-api"]`; and a variant of V with an extra claim `"name": "Alice"` and a header `kid` "k1"
- **Then** V gives user id C1 with role `customer`; the second gives user id O1 with role `operator`; the uppercase `sub` gives user id C1 in lowercase; the last two are accepted and give user id C1 with role `customer`

### AUT-AC02 · Every request without a valid token gets the same 401

- **Level:** integration
- **Covers:** AUT-R01, AUT-R02, AUT-R06, AUT-R20
- **Given** A1 with "10000" EUR
- **When** C1's read of A1 and C1's withdrawal of "100" EUR from A1 are each sent: with no `Authorization` header; with `Authorization: Basic dXNlcjpwYXNz`; with `Authorization: Bearer` and no token; with `Authorization: Bearer abc.def`; with a token whose payload segment is not base64url JSON; with no header and V in the query string as `?access_token=<V>`; with a variant of V whose `exp` is T − 60 and `iat` T − 600 (expired); with a variant whose `iat` is T + 600 and `exp` T + 900 (not yet valid); with V signed with K2 (wrong signature); with a variant whose header `alg` is "none" and whose signature is empty; with a variant whose `iss` is "other"; with a variant whose `aud` is "other"; and with a variant whose `role` is "admin"; and then the health check and the API documentation are requested with the expired variant and with no header
- **Then** all 26 requests to A1 answer 401 with type `/problems/unauthenticated`, bodies whose members are equal except `requestId`, and the same `WWW-Authenticate` header; the balance of A1 stays "10000" EUR and no idempotency record exists for any of the withdrawals; and the health check and the API documentation answer 200 with and without the expired token

### AUT-AC03 · Expiry, not-before and lifetime are checked with a 5-second tolerance

- **Level:** unit
- **Covers:** AUT-R03, AUT-R04, AUT-R05
- **Given** the token verifier with its clock at T
- **When** it verifies variants of V with: `iat` T − 600 and `exp` T − 5; `iat` T − 600 and `exp` T − 4; `iat` T + 5 and `exp` T + 600; `iat` T + 6 and `exp` T + 600; `nbf` T + 5; `nbf` T + 6; `iat` T and `exp` T + 900; `iat` T and `exp` T + 901; `iat` T and `exp` T; no `exp`; no `iat`; and `exp` as the string "1791375240"
- **Then** the variants with `exp` T − 4, `iat` T + 5, `nbf` T + 5 and `exp` − `iat` = 900 are accepted; every other variant is rejected with the one error type that the HTTP edge maps to 401 `/problems/unauthenticated`, whose internal reason is `expired` for `exp` T − 5, `not_yet_valid` for `iat` T + 6 and `nbf` T + 6, `lifetime` for `exp` − `iat` of 901 and of 0, and `claims` for the missing or non-numeric claims

### AUT-AC04 · Only HS256 signed with the configured secret is accepted

- **Level:** unit
- **Covers:** AUT-R02
- **Given** the token verifier with its clock at T, an RSA-2048 key pair, a P-256 key pair and a third 48-byte secret K3
- **When** it verifies: V signed with K2; V with the last character of its signature changed; V with its payload replaced by one whose `role` is "operator" and its original signature kept; variants of V whose header `alg` is "none" with an empty signature, "none" with V's signature, "None", and "hs256"; V signed with K under `alg` "HS384" and under "HS512"; V signed under "RS256" with the RSA private key and under "ES256" with the P-256 private key; V signed with K3 under "HS256" with a header `jwk` holding K3 as an `oct` key; a variant of V whose header has `"crit": ["x-ext"]` and `"x-ext": true`; and a five-segment JWE
- **Then** every one is rejected with the error type that the HTTP edge maps to 401 `/problems/unauthenticated`, with internal reason `signature` or `algorithm`; and V itself is accepted

### AUT-AC05 · Issuer, audience, role and subject are checked

- **Level:** unit
- **Covers:** AUT-R03
- **Given** the token verifier with its clock at T
- **When** it verifies variants of V with: `iss` "other"; no `iss`; `aud` "other"; `aud` `["other"]`; no `aud`; `role` "admin"; `role` "Customer"; `role` ""; `role` `["customer"]`; no `role`; `sub` ""; `sub` "not-a-uuid"; `sub` 123; and no `sub`
- **Then** every one is rejected with the error type that the HTTP edge maps to 401 `/problems/unauthenticated`, with internal reason `claims`

### AUT-AC06 · Tokens and the secret never reach a log, and a 401 logs which check failed

- **Level:** integration
- **Covers:** AUT-R19
- **Given** the service with its log output captured, A1 owned by C1, E the expired variant of V of AUT-AC02, and W V signed with K2
- **When** C1 reads A1 with V and `X-Request-Id: req-ok`, with E and `X-Request-Id: req-exp`, and with W and `X-Request-Id: req-sig`; and C1 withdraws "100" EUR from A1 with V
- **Then** no captured log line, problem details body or audit record contains V, E, W, the signature segment of any of them, or K; the request "req-exp" has exactly one `warn` line with correlation id "req-exp" and reason code `expired`, and "req-sig" exactly one with reason code `signature`; and neither 401 body contains "expired" or "signature"

### AUT-AC07 · A customer on an operator-only endpoint gets 403

- **Level:** integration
- **Covers:** AUT-R10
- **Given** A1, `active` with "1000" EUR, B1, `active` with "1000" EUR, and D, a deposit of "1000" EUR into A1
- **When** C1 deposits "100" EUR into A1, B1 and U; freezes, unfreezes and closes A1, B1 and U; and reverses D and the transaction id U with `{"reason": "duplicate"}`
- **Then** all 14 requests answer 403 with type `/problems/forbidden` and bodies that differ only in `requestId`; A1 and B1 stay `active` with "1000" EUR; D has no reversal; and no idempotency record exists for any of the requests

### AUT-AC08 · An operator on a customer-only endpoint gets 403

- **Level:** integration
- **Covers:** AUT-R11
- **Given** A1 with "1000" EUR and B1 with "0" EUR
- **When** O1 creates an account with `{"currency": "EUR"}`, lists accounts, withdraws "100" EUR from A1 and from U, and transfers "100" EUR from A1 to B1 and from U to B1
- **Then** all six requests answer 403 with type `/problems/forbidden` and bodies that differ only in `requestId`; no account is created; A1 stays "1000" EUR and B1 "0" EUR; and no transaction or idempotency record is added

### AUT-AC09 · Another customer's account looks like an unknown one

- **Level:** integration
- **Covers:** AUT-R12
- **Given** A1 with "1000" EUR and B1 with "5000" EUR
- **When** C1 reads B1, lists the history of B1, withdraws "100" EUR from B1 and transfers "100" EUR from B1 to A1; and C1 sends the same four requests with U in place of B1
- **Then** all eight answer 404 with type `/problems/not-found`; each request on B1 has a body equal, except for `requestId`, to the same request on U; and B1 stays "5000" EUR and A1 "1000" EUR with no transaction added

### AUT-AC10 · A transfer may go to another customer's account

- **Level:** integration
- **Covers:** AUT-R13
- **Given** A1, `active` with "1000" EUR; B1, `active` with "0" EUR; and F2, owned by C2, `frozen` with "0" EUR
- **When** C1 transfers "300" EUR from A1 to B1, then "100" EUR from A1 to F2, then "100" EUR from A1 to U
- **Then** the first answers 201 with `accountId` A1 and `balance` "700" and no member holding B1's balance, and B1 is "300" EUR; the other two answer 422 with type `/problems/destination-unavailable` and bodies that differ only in `requestId`; and A1 ends at "700" EUR

### AUT-AC11 · The user id and role come only from the token

- **Level:** integration
- **Covers:** AUT-R07, AUT-R08, AUT-R09
- **Given** A1 with "1000" EUR, B1 with "1000" EUR, and C1 and C2 owning no other account
- **When** C1 creates an account with `{"currency": "EUR", "ownerId": C2}`; C1 withdraws `{"amount": "100", "currency": "EUR", "userId": C2}` from A1; C1 lists accounts with `?ownerId=<C2>`; C1 reads B1 with the header `X-User-Id: <C2>`; C1 lists accounts with the header `X-User-Id: <C2>`; and C1 deposits `{"amount": "100", "currency": "EUR", "role": "operator"}` into A1
- **Then** the creation answers 422 with type `/problems/validation-error` and one `errors` entry, for `ownerId`, and neither C1 nor C2 gets a new account; the withdrawal answers 422 with one `errors` entry, for `userId`; the list with `ownerId` answers 422 with one `errors` entry, for `ownerId`; the read of B1 answers 404 with type `/problems/not-found`; the list with `X-User-Id` answers 200 with only A1; the deposit answers 403 with type `/problems/forbidden`; and A1 and B1 stay "1000" EUR

### AUT-AC12 · The token script mints a token the API accepts

- **Level:** integration
- **Covers:** AUT-R16
- **Given** the configuration above and A1 with "0" EUR
- **When** `npm run --silent token -- --sub <C1 in uppercase> --role customer` runs, recording the time before and after it as T1 and T2; then `npm run --silent token -- --sub <O1> --role operator` runs; and the two tokens are used for C1's read of A1 and O1's deposit of "100" EUR into A1
- **Then** each run exits with code 0 and prints on stdout exactly one line, a compact JWS of three base64url segments; the first token's header is exactly `{"alg": "HS256", "typ": "JWT"}` and its claims are exactly `sub` C1 in lowercase, `role` "customer", `iat` not earlier than T1 and not later than T2, both in whole seconds rounded down, `exp` equal to `iat` + 900, `iss` "scf-test" and `aud` "scf-api"; its signature verifies with K; the read answers 200 and the deposit 201; and neither run's stdout or stderr contains K

### AUT-AC13 · The token script refuses bad arguments and configuration

- **Level:** unit
- **Covers:** AUT-R17, AUT-R19
- **Given** the token script and the configuration above
- **When** it runs with `--role customer` and no `--sub`; with `--sub not-a-uuid --role customer`; with `--sub <C1>` and no `--role`; with `--sub <C1> --role admin`; with `--sub <C1> --role customer --ttl 3600`; with `--sub <C1> --role customer` and `JWT_SECRET` unset; and with `--sub <C1> --role customer` and `JWT_SECRET` set to the 31-byte value "0123456789012345678901234567890"
- **Then** every run exits with a non-zero code, prints nothing on stdout, and prints on stderr a message naming the argument or variable at fault; and no stderr contains K or "0123456789012345678901234567890"

### AUT-AC14 · No endpoint issues tokens

- **Level:** integration
- **Covers:** AUT-R15
- **Given** the production app built by the composition root (SYS-AC24)
- **When** `POST` and `GET` requests are sent to `/token`, `/tokens`, `/auth/token`, `/oauth/token`, `/login` and `/sessions`, each path with and without the `/v1` prefix, each without credentials and with V; and the app's route list is read
- **Then** all 48 requests answer 404 with type `/problems/not-found`; and no route in the list has a path containing "token", "login", "session", "oauth" or "auth"

### AUT-AC15 · The service refuses a weak or missing token configuration

- **Level:** unit
- **Covers:** AUT-R18
- **Given** the configuration loader and an otherwise valid environment
- **When** it loads with `JWT_SECRET` unset, set to "change-me", set to a 31-byte value S31 and set to a 32-byte value S32; with `JWT_ISSUER` unset and set to ""; and with `JWT_AUDIENCE` unset and set to ""
- **Then** the load with S32 succeeds; every other load fails with a configuration error that names the variable at fault; and no error message contains "change-me" or S31

### AUT-AC16 · Every cell of the authorization matrix holds, on every replica

- **Level:** e2e
- **Covers:** AUT-R10, AUT-R11, AUT-R12, AUT-R14, AUT-R21
- **Given** two replicas behind the load balancer; and, prepared afresh for each request: C1 owning A1, `active` with "10000" EUR, and A2, `active` with "0" EUR; C2 owning B1, `active` with "10000" EUR, and B2, `active` with "0" EUR; Tc, a deposit of "1000" EUR into A1, and Tf, a deposit of "1000" EUR into B1; the own account for C1 is A1 (A2 for M07), the foreign account is B1 (B2 for M07), the operator's account is B1 (B2 for M07), the own transaction is Tc, and the foreign transaction and the operator's transaction are Tf; for M06 the account is first frozen by O1; the destination of M10 is A2 and of M11 is B2 (for the foreign source, A1)
- **When** one table-driven e2e test sends each of the 50 cells of table 1.3 once to replica 1 and once to replica 2, with no `Authorization` header for the "No valid token" column, C1's token for the customer columns and O1's token for the operator column, a valid body for each endpoint ("100" EUR for movements, `{"currency": "EUR"}` for M01, `{"reason": "correction"}` for M13), and a fresh Idempotency-Key for every POST that takes one
- **Then** each of the 100 requests answers the status and, for an error, the problem type its cell states; each error leaves every balance, account status, transaction and idempotency record as it was; each success makes the change of its row (for M02 only C1's accounts are listed, for M03 the operator's body has `ownerId` C2, for M12 the customer sees only the entry on A1 and the operator every entry); and the test fails if its list of cases and the cells of table 1.3 differ in number, endpoint, column or expected answer

## 4. Error catalogue

Errors shared by every capability are in spec 000. For authentication and authorization:

| Condition                                                                                                                                                                                                            | HTTP | Problem type               | Stored for idempotent replay                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------- | ------------------------------------------------------------------------ |
| No `Authorization` header, a header that is not one Bearer credential, or a token that is malformed, expired, not yet valid, too long-lived, wrongly signed, not HS256, or has a wrong `iss`, `aud`, `sub` or `role` | 401  | /problems/unauthenticated  | no                                                                       |
| A customer requests a deposit, freeze, unfreeze, close or reversal, whatever id the path names                                                                                                                       | 403  | /problems/forbidden        | no                                                                       |
| An operator requests to create an account, list accounts, withdraw or transfer, whatever id the path names                                                                                                           | 403  | /problems/forbidden        | no                                                                       |
| A customer reads, lists the history of, withdraws from or transfers out of another customer's account                                                                                                                | 404  | /problems/not-found        | yes for withdrawals and transfers (spec 005, section 1.3); n/a for reads |
| A body or query string member the endpoint does not define, such as `ownerId`, `userId`, `sub` or `role`                                                                                                             | 422  | /problems/validation-error | no                                                                       |
| A request to a token-issuing path such as `/token` or `/login`, which does not exist                                                                                                                                 | 404  | /problems/not-found        | no                                                                       |

## 5. Invariants

- Every request to a route that requires authentication is processed for exactly one user id and one role, both taken from a token that passed every check of section 1.1 (AUT-AC01 to AUT-AC05, AUT-AC11).
- A customer never reads, debits or learns the existence of another customer's account through the account in the path (AUT-AC09, AUT-AC16).
- A 401 answer never depends on which check failed (AUT-AC02, AUT-AC06).
- No token, `Authorization` header value or `JWT_SECRET` appears in a log line, problem details body or audit record (AUT-AC06).
- Every replica accepts and rejects the same tokens (AUT-AC16).
- The invariants of spec 000 hold before and after every operation of this spec.

## 6. Out of scope

- An external OpenID Connect provider, asymmetric signatures (RS256, ES256) and key discovery through JWKS. The production design is recorded in [ADR-0012](../../docs/adr/0012-simulated-authentication-with-jwt-and-two-roles.md), including the mapping an OIDC provider whose subjects are not UUIDs would need.
- Login, user registration, passwords, multi-factor authentication, refresh tokens and token revocation. A token lives at most 15 minutes and cannot be revoked before it expires.
- Rotating `JWT_SECRET` without a restart, and accepting more than one secret at a time.
- Scopes or permissions beyond the two roles.
- A user registry: a customer is the `sub` of a token with role `customer` (section 1 of spec 001).
- Rate limiting of failed authentication attempts (spec 007).
- Timing side channels of token verification and of the ownership check.

## 7. Open questions

None. Every question raised while writing this spec was decided by the owner on 2026-10-07 and is stated above as a rule.
