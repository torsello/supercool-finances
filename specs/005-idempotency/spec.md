# 005 · Idempotency

- **Status:** Implemented
- **ID prefix:** IDM
- **Related ADRs:** [ADR-0001](../../docs/adr/0001-spec-driven-development-with-adrs-and-ai-agents.md), [ADR-0002](../../docs/adr/0002-modular-monolith.md), [ADR-0003](../../docs/adr/0003-hexagonal-architecture-with-tactical-ddd.md), [ADR-0004](../../docs/adr/0004-typescript-with-fastify.md), [ADR-0005](../../docs/adr/0005-postgresql-as-the-only-source-of-truth.md), [ADR-0008](../../docs/adr/0008-read-committed-with-ordered-pessimistic-row-locks.md), [ADR-0009](../../docs/adr/0009-idempotency-inside-the-movements-transaction.md), [ADR-0010](../../docs/adr/0010-kysely-and-pg-instead-of-an-orm.md), [ADR-0012](../../docs/adr/0012-simulated-authentication-with-jwt-and-two-roles.md), [ADR-0014](../../docs/adr/0014-aws-deployment-on-ecs-fargate-with-rds-postgresql.md), [ADR-0016](../../docs/adr/0016-error-model.md), [ADR-0019](../../docs/adr/0019-timeout-layers-and-rds-proxy.md), [ADR-0021](../../docs/adr/0021-statement-timeout-function-for-maintenance-scripts.md), [ADR-0022](../../docs/adr/0022-request-timeout-answer-first-then-roll-back.md)
- **Depends on specs:** 000-overview, 001-accounts, 002-ledger, 003-money-movements, 004-reversals, 007-security-ops, 008-deployment

## 1. Context and goal

Clients retry: a timeout, a dropped connection or a crashed replica leaves them not knowing whether money moved. A retry must never move money twice, and must get the same answer as the first attempt. Every money-moving POST (deposit, withdrawal, transfer, reversal) therefore carries an `Idempotency-Key`, and account creation may carry one. The service remembers, per user and key, a fingerprint of the request and the response it gave, and answers a retry with that stored response instead of running the request again.

Several replicas run behind a load balancer (SYS-R16), so this state lives only in PostgreSQL. The key row is inserted inside the request's own database transaction, as its first write: the movement and the record of its result commit together or not at all, and a second request with the same key, on any replica, waits on that row until the first finishes. This design is recorded in [ADR-0009](../../docs/adr/0009-idempotency-inside-the-movements-transaction.md). Terms have the meanings in the glossary of spec 000.

### 1.1 Life of a request with a key

Within the order of SYS-R31:

1. Route (404), authentication (401), per-user rate limit (429), role (403), media type (415), body size (413) and malformed request (400), which includes the format of the key (IDM-R03). Nothing is stored for any of them.
2. The fingerprint of the request is computed (IDM-R05).
3. The database transaction begins (READ COMMITTED). `lock_timeout` is set to `IDEMPOTENCY_WAIT_TIMEOUT_MS` through the lock-timeout function (SEC-R31), and the key row of (user, key) is inserted, in progress. If another request holds that row, the insert waits for it to commit or roll back.
   - The row exists, has not expired and has the same fingerprint: the stored response is replayed and nothing is written (IDM-R07).
   - The row exists, has not expired and has another fingerprint: 422 `/problems/idempotency-key-reused` (IDM-R09).
   - The row exists and has expired: it is replaced, and the request goes on as a first request (IDM-R21).
   - The wait ends with SQLSTATE 55P03: 409 `/problems/request-in-progress` (IDM-R12).
4. A savepoint is taken.
5. Validation (422 `/problems/validation-error`).
6. Lookup (404) and business rules (409, 422), with `lock_timeout` set to `ACCOUNT_LOCK_TIMEOUT_MS` through the lock-timeout function (SEC-R31) immediately before the first account lock (spec 003 section 1.4, spec 004 section 1.4).
7. The outcome decides what is stored (section 1.3), then the database transaction commits or rolls back.

Account creation (spec 001) follows the same steps when it carries a key; it locks no account.

### 1.2 Key record

| Field         | Holds                                                                                                                                                                                                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `userId`      | The `sub` of the caller's verified token. The key is scoped to it.                                                                                                                                                                                                                           |
| `key`         | The `Idempotency-Key` value, exactly as sent.                                                                                                                                                                                                                                                |
| `fingerprint` | The SHA-256 of the request (IDM-R05), as 64 lowercase hex characters.                                                                                                                                                                                                                        |
| `status`      | The HTTP status of the stored response.                                                                                                                                                                                                                                                      |
| `headers`     | The stored response headers that describe its body: `Content-Type`, and `Location` on a 201, so a replayed 201 still points to the transaction or account. Headers that belong to the current request (`X-Request-Id`, `Idempotent-Replayed`) are never stored; they are set on each answer. |
| `body`        | The stored response body, as the exact bytes sent to the client.                                                                                                                                                                                                                             |
| `createdAt`   | When the key row was inserted.                                                                                                                                                                                                                                                               |
| `expiresAt`   | `createdAt` plus `IDEMPOTENCY_KEY_TTL_SECONDS`, counted from the row's creation, not its completion: a request lasts at most the request timeout (SYS-R35), so the two differ by seconds.                                                                                                    |

The primary key is (`userId`, `key`). A row is committed only with `status`, `headers` and `body` set (IDM-R18).

### 1.3 What is stored

| Outcome                                                                                                                                                                                                                                                                                                                       | Where it is decided           | Effect on the database transaction                                                | Stored for replay                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 201 created                                                                                                                                                                                                                                                                                                                   | after the business rules      | the effects, the audit record and the response commit                             | yes                                                                            |
| 404 `/problems/not-found` for the resource in the path                                                                                                                                                                                                                                                                        | lookup                        | rolled back to the savepoint; the response commits                                | yes                                                                            |
| A business rejection: 409 `/problems/already-reversed`, and 422 `/problems/currency-mismatch`, `/problems/account-not-active`, `/problems/insufficient-funds`, `/problems/destination-unavailable`, `/problems/balance-limit-exceeded`, `/problems/transaction-not-reversible` or `/problems/insufficient-funds-for-reversal` | business rules                | rolled back to the savepoint; the response commits                                | yes                                                                            |
| 422 `/problems/validation-error`                                                                                                                                                                                                                                                                                              | validation                    | rolled back entirely                                                              | no                                                                             |
| 422 `/problems/idempotency-key-reused`, 409 `/problems/request-in-progress`                                                                                                                                                                                                                                                   | key step                      | rolled back entirely                                                              | no                                                                             |
| 503 for an account lock timeout, 503 after the last retry of a deadlock or serialization failure, 503 for the request timeout before its `COMMIT` was sent, 500 for any other failure, including a ledger write the database rejects                                                                                          | anywhere after the key insert | rolled back entirely                                                              | no                                                                             |
| 503 for the request timeout after its `COMMIT` was sent (SEC-R33)                                                                                                                                                                                                                                                             | at the commit                 | the commit finishes; the outcome is unknown to the client, as for a gateway error | yes if the commit succeeds: a retry with the same key gets the stored response |
| 400, 401, 403, 404 for an unknown route, 413, 415, 429                                                                                                                                                                                                                                                                        | before the key step           | no database transaction                                                           | no                                                                             |

Everything decided at the lookup or business-rule steps is stored, and nothing else is. A stored 404 for the resource in the path stays true, because accounts and transactions are never deleted.

### 1.4 Configuration

| Variable                      | Meaning                                                                             | Range                                                                                                                                   | Default      |
| ----------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `IDEMPOTENCY_WAIT_TIMEOUT_MS` | How long a request waits for another request holding the same key, in milliseconds. | 1 to 4999, below the runtime role's `statement_timeout` of 5 s (spec 007)                                                               | 2000         |
| `IDEMPOTENCY_KEY_TTL_SECONDS` | How long a key row is kept before it expires, in seconds.                           | 3600 (1 h) to 2592000 (30 days); the minimum, far above the request timeout (SYS-R35), means a key never expires while its request runs | 86400 (24 h) |

Both are validated at startup like `MAX_AMOUNT_MINOR` (IDM-R23). Their final values, against the request timeout, are fixed in spec 007 (SYS-R35).

A key expires at its TTL, whatever the cleanup has done: the insert replaces an expired row (IDM-R21), and the cleanup (IDM-R22) only bounds the table's size. A request retried after its key expired runs as a new request and can move money a second time; the API documentation states the TTL, and clients must not retry a request older than that with the same key. Keeping keys for good would make the table grow without bound.

## 2. Requirements

| ID      | Requirement (EARS)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IDM-R01 | IF a deposit, withdrawal, transfer or reversal request has no `Idempotency-Key` header THEN THE SYSTEM SHALL answer 400 with problem type `/problems/malformed-request` and write nothing (SYS-R26, MOV-R07, REV-R13).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| IDM-R02 | WHERE an account creation request carries an `Idempotency-Key`, THE SYSTEM SHALL apply this spec to it; without one, it SHALL create a new account for every request (ACC-R03, ACC-R04).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| IDM-R03 | IF an `Idempotency-Key` header is sent more than once, or its value is empty, longer than 255 characters, or contains a character outside the visible ASCII range U+0021 to U+007E (space excluded), THEN THE SYSTEM SHALL answer 400 with problem type `/problems/malformed-request` and write nothing, on every endpoint that takes a key, account creation included. A key sent twice arrives joined with ", ", which is not visible ASCII; choosing one of the values would hide a client bug.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| IDM-R04 | THE SYSTEM SHALL scope every key to the authenticated user (the `sub` of the token) and compare keys exactly, case included, so that two users can use the same key independently, and one user's key space covers every endpoint that takes a key, so a key reused on another endpoint has another fingerprint and answers as IDM-R09.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| IDM-R05 | THE SYSTEM SHALL compute a request's fingerprint as the SHA-256 of the UTF-8 bytes of its method, a line feed, its path as received without the query string and without normalization, a line feed, and its body in the JSON Canonicalization Scheme of RFC 8785 (object keys sorted by UTF-16 code units at every level, no whitespace, minimal string escapes), so that key order and whitespace never change the fingerprint and any other difference does, including an id in the path written in another letter case. A body that parses as JSON but that RFC 8785 cannot encode, a number outside the range of an IEEE 754 double (such as `1e400`) or nesting deeper than 64 levels, is fingerprinted with a fixed marker in place of its canonical JSON; the marker is never the canonical JSON of any value, so no other body shares its fingerprint, and such a body never passes validation, so its outcome is never stored. |
| IDM-R06 | THE SYSTEM SHALL insert the key row as the first write of the request's database transaction, at the replay step of SYS-R31, before validation, and keep no idempotency state outside PostgreSQL (SYS-R16).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| IDM-R07 | WHEN a request's key matches an unexpired key row of the same user with the same fingerprint and a stored response THE SYSTEM SHALL answer with the stored status, headers and body unchanged, the body including its original `requestId`, plus the current request's `X-Request-Id` and the header `Idempotent-Replayed: true`, and write nothing: no transaction, ledger entry, balance change, audit record or change to the key row (SYS-R33).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| IDM-R08 | THE SYSTEM SHALL answer a replay from the stored bytes after only the steps of SYS-R31 that come before it (route, authentication, per-user rate limit, role, media type, body size and malformed request), and before validation, lookup and every later check, including those that depend on configuration, on the current state of the accounts or on the version of the code, without checking the query string, which is not part of the fingerprint (IDM-R05), so that the stored response is returned after `MAX_AMOUNT_MINOR` or another setting changed, after the accounts involved changed, and by a replica that runs a different version.                                                                                                                                                                                                                                                                                  |
| IDM-R09 | IF a request's key matches an unexpired key row of the same user with a different fingerprint THEN THE SYSTEM SHALL answer 422 with problem type `/problems/idempotency-key-reused`, write nothing, and leave the key row and its stored response unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| IDM-R10 | WHILE a request with a key is in progress THE SYSTEM SHALL make every other request of the same user with the same key, on any replica, wait until the first commits or rolls back, and then answer it as IDM-R07 or IDM-R09 if the first stored a response, or process it as a first request if the first rolled back entirely, so that the request is executed at most once.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| IDM-R11 | THE SYSTEM SHALL bound the wait of IDM-R10 by setting `lock_timeout` to `IDEMPOTENCY_WAIT_TIMEOUT_MS` through the lock-timeout function of SEC-R31 immediately before inserting the key row, and to `ACCOUNT_LOCK_TIMEOUT_MS` the same way immediately before the first account lock (MOV-R19), so that each wait has its own bound.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| IDM-R12 | IF the insert of the key row fails with SQLSTATE 55P03, or does not complete within `IDEMPOTENCY_WAIT_TIMEOUT_MS`, THEN THE SYSTEM SHALL roll back the database transaction, store nothing, and answer 409 with problem type `/problems/request-in-progress` and the header `Retry-After: 1`, never 503 (MOV-R29).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| IDM-R13 | IF SQLSTATE 55P03 is raised after the key row is inserted, by an account row lock, THEN THE SYSTEM SHALL roll back the whole database transaction, key row included, and answer 503 with problem type `/problems/service-unavailable` and the header `Retry-After: 1` (MOV-R20, REV-R19).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| IDM-R14 | THE SYSTEM SHALL take a savepoint immediately after inserting the key row; IF the request is then refused at the lookup step (404) or by a business rule (409 or 422 other than `/problems/validation-error`) THEN THE SYSTEM SHALL roll back to the savepoint, store the response in the key row and commit, so that the rejection leaves no transaction, ledger entry, balance change or audit record and the key row holds its result, including when the rejection is raised by a database constraint (REV-R06).                                                                                                                                                                                                                                                                                                                                                                                                                     |
| IDM-R15 | WHEN a request succeeds THE SYSTEM SHALL store its response in the key row in the same database transaction as its effects and audit record.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| IDM-R16 | IF a request fails validation (422 `/problems/validation-error`) THEN THE SYSTEM SHALL roll back the whole database transaction, key row included, so that nothing is stored and a corrected request with the same key is a first request.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| IDM-R17 | IF a request fails with a 500 or a 503, including after the last retry of SYS-R18, which re-runs the whole database transaction with its key insert, THEN THE SYSTEM SHALL roll back the whole database transaction, key row included, so that nothing is stored and a retry with the same key executes the request again; except a 503 for the request timeout whose `COMMIT` was already sent (SEC-R33), whose outcome is unknown to the client, as for a gateway error: if that commit succeeds, the key row holds its response and a retry with the same key gets it.                                                                                                                                                                                                                                                                                                                                                                |
| IDM-R18 | THE SYSTEM SHALL never commit a key row without a stored status, headers and body, enforced at commit by a deferred constraint trigger (`DEFERRABLE INITIALLY DEFERRED`) on the key table, whatever the code that writes it, so that a defect fails loudly instead of leaving a key that blocks retries until it expires.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| IDM-R19 | WHEN a request committed but its response did not reach the client (a crash, a lost connection) and the client retries with the same key and fingerprint THE SYSTEM SHALL answer the stored response as IDM-R07, with no effect applied a second time.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| IDM-R20 | THE SYSTEM SHALL set each key row's expiry to its creation time plus `IDEMPOTENCY_KEY_TTL_SECONDS`, default 86400 seconds (24 hours) when the variable is unset.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| IDM-R21 | WHEN a request's key matches a key row of the same user that has expired THE SYSTEM SHALL replace that row and process the request as a first request, whatever its fingerprint, whether or not the cleanup has deleted the row yet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| IDM-R22 | WHEN `npm run idempotency:cleanup` is run THE SYSTEM SHALL, against `DATABASE_URL`, delete every key row that has expired, and no other, in batches of 1000 rows, skipping rows locked by a request in progress (`FOR UPDATE SKIP LOCKED`) instead of waiting for them, print `{"deleted": n}` with the number of deleted rows on standard output, exit with code 0 when it completes and 2 when it cannot run, and never print credentials. The cleanup never runs inside the service, so replicas never race on it; in production it runs every hour (DEP-R37).                                                                                                                                                                                                                                                                                                                                                                        |
| IDM-R23 | IF `IDEMPOTENCY_WAIT_TIMEOUT_MS` is set to a value that is not a string of decimal digits without sign or leading zero from 1 to 4999, below the runtime role's `statement_timeout` of 5 seconds (SEC-R29) so that the wait always ends as SQLSTATE 55P03 and never as 57014, or `IDEMPOTENCY_KEY_TTL_SECONDS` to one that is not such a string from 3600 to 2592000, so that a key can never expire while its request is still running, THEN THE SYSTEM SHALL refuse to start, with an error that names the variable.                                                                                                                                                                                                                                                                                                                                                                                                                   |

## 3. Acceptance criteria

Unless stated otherwise: customer user C1 owns account A1 (EUR) and A2 (EUR), customer user C2 owns account B1 (EUR), operator user O1 is an operator, balances are set up by deposits from O1, S is the EUR settlement account, U is an account id that does not exist, `MAX_AMOUNT_MINOR` is unset, `IDEMPOTENCY_WAIT_TIMEOUT_MS` and `IDEMPOTENCY_KEY_TTL_SECONDS` are unset, and every reversal has the body `{"reason": "Operator correction"}`. Replicas P1 and P2 are two instances of the app built by the composition root, each with its own connection pool, against the same database. "The key row of (C1, k1)" is the key record of section 1.2 for user C1 and key k1, and "written directly to the database" means SQL run by the service's runtime database role outside the service's code.

### IDM-AC01 · Money-moving requests require a key

- **Level:** integration
- **Covers:** IDM-R01
- **Given** A1 with "1000" EUR and B1 with "0" EUR; O1 deposited "1000" EUR into A1 as D
- **When** O1 deposits "100" EUR into A1, C1 withdraws "100" EUR from A1, C1 transfers "100" EUR from A1 to B1, and O1 reverses D, each without an `Idempotency-Key` header
- **Then** all four answer 400 with type `/problems/malformed-request`; A1 stays "1000" EUR and B1 "0" EUR; D has no reversal; and no transaction, audit record or key row is added

### IDM-AC02 · Key format

- **Level:** unit
- **Covers:** IDM-R03
- **Given** the `Idempotency-Key` header parser
- **When** it parses "k", "k1", "018f2a00-0000-7000-8000-00000000000a", "!~", 255 × "x", and then the header absent, "", 256 × "x", "a b", " k1", "k1 ", "clé", "k\t1", "k\u007f1", and the header sent twice as "k1" and "k2"
- **Then** the first five are accepted as sent; the absent header is reported as missing; and each of the others is rejected as malformed

### IDM-AC03 · A malformed key answers 400 on every endpoint that takes one

- **Level:** integration
- **Covers:** IDM-R03
- **Given** C1 has only A1, with "1000" EUR
- **When** C1 creates an account with `{"currency": "EUR"}` and `Idempotency-Key: bad key`; C1 withdraws "100" EUR from A1 with a key of 256 × "x"; and C1 withdraws "100" EUR from A1 with the header `Idempotency-Key` sent twice, as "k1" and "k2"
- **Then** all three answer 400 with type `/problems/malformed-request`; C1 still has only A1, with "1000" EUR; and no transaction or key row is added

### IDM-AC04 · A key is optional on account creation

- **Level:** integration
- **Covers:** IDM-R02
- **Given** C1 has no accounts
- **When** C1 posts `{"currency": "EUR"}` to create an account with Idempotency-Key k1, then the same request with k1 again, then the same body twice without a key
- **Then** the first answers 201; the second answers 201 with the same `Location` and body and the header `Idempotent-Replayed: true`; the last two answer 201 with two other ids; and C1 has three accounts

### IDM-AC05 · Keys are scoped per user and shared across endpoints

- **Level:** integration
- **Covers:** IDM-R04
- **Given** A1 with "1000" EUR and B1 with "1000" EUR
- **When** C1 withdraws "100" EUR from A1 with Idempotency-Key k1; C2 withdraws "100" EUR from B1 with k1; C2 withdraws "100" EUR from B1 with K1; and then C1 transfers "100" EUR from A1 to B1 with k1
- **Then** the three withdrawals answer 201, none with the header `Idempotent-Replayed`, and three withdrawal transactions exist; C1's transfer answers 422 with type `/problems/idempotency-key-reused`; and A1 is "900" EUR and B1 "800" EUR

### IDM-AC06 · Fingerprint

- **Level:** unit
- **Covers:** IDM-R05
- **Given** the fingerprint function and the account id a = "018f2a00-0000-7000-8000-00000000000a"
- **When** it fingerprints POST `/accounts/a/withdrawals` with the bodies `{"amount":"100","currency":"EUR"}`, `{"currency":"EUR","amount":"100"}` and `{ "amount" : "100" ,  "currency" : "EUR" }`; POST `/x` with `{"b":{"y":1,"x":[2,{"d":3,"c":4}]},"a":"1"}` and with `{"a":"1","b":{"x":[2,{"c":4,"d":3}],"y":1}}`; and then POST `/accounts/a/withdrawals` with `{"amount":"101","currency":"EUR"}`, POST `/accounts/a/transfers` with `{"amount":"100","currency":"EUR"}`, POST with the path written with a in uppercase, and POST `/x` with `{"a":"1","b":{"x":[{"c":4,"d":3},2],"y":1}}`; and finally POST `/accounts/a/withdrawals` with the parsed body `{"amount":1e400,"currency":"EUR"}` and with a body of 65 levels of nested arrays
- **Then** the first three fingerprints are equal to each other and to the SHA-256, as 64 lowercase hex characters, of the method, the path and `{"amount":"100","currency":"EUR"}` in the encoding of IDM-R05; the two `/x` bodies have equal fingerprints; each of the last four before the final two differs from the fingerprint it varies from, array order included; and the final two are fingerprinted without an error, each as the SHA-256 of the method, the path and the fixed marker of IDM-R05, and differ from the fingerprints of every other body of this AC

### IDM-AC07 · A completed request is replayed unchanged

- **Level:** integration
- **Covers:** IDM-R07, IDM-R08, IDM-R15, SYS-R23
- **Given** A1 with "5000" EUR
- **When** C1 withdraws "1200" EUR from A1 with Idempotency-Key k1 and `X-Request-Id: r1`; O1 deposits "1000" EUR into A1; C1 sends the same withdrawal with k1 and `X-Request-Id: r2`; and C1 sends it once more with k1, `X-Request-Id: r3` and the query string `?ownerId=<C2>`
- **Then** the first answers 201 with `balance` "3800" and no header `Idempotent-Replayed`; the replay answers 201 with the same `Location` and `Content-Type`, a body byte for byte equal to the first's, still with `balance` "3800", the header `X-Request-Id: r2` and the header `Idempotent-Replayed: true`; the request with the query string answers the same way, 201 with the same body and `Idempotent-Replayed: true`, not 422; A1 is "4800" EUR; exactly one withdrawal transaction and one withdrawal audit record exist for k1; and the key row of (C1, k1) is the same before and after the replay

### IDM-AC08 · A replay ignores configuration, account state and code version

- **Level:** integration
- **Covers:** IDM-R08, SYS-R31, SYS-R33
- **Given** A1 with "1000" EUR, and the test app (SYS-R37) started with `MAX_AMOUNT_MINOR` unset
- **When** C1 withdraws "500" EUR from A1 with Idempotency-Key k1; O1 freezes A1; the test app is restarted against the same database with `MAX_AMOUNT_MINOR` "100" and a hook that adds the member `"apiVersion": 2` to every new response body, standing for a replica of another version; and C1 sends the same withdrawal with k1, and then withdraws "500" EUR with k2
- **Then** the k1 replay answers 201 with a body byte for byte equal to the first response, without `apiVersion`, and the header `Idempotent-Replayed: true`, not 422; the k2 withdrawal answers 422 with type `/problems/validation-error` and an `apiVersion` member; and A1 is "500" EUR with exactly one withdrawal transaction

### IDM-AC09 · A key reused with another request answers 422

- **Level:** integration
- **Covers:** IDM-R09
- **Given** A1 with "1000" EUR and B1 with "0" EUR
- **When** C1 withdraws `{"amount": "100", "currency": "EUR"}` from A1 with Idempotency-Key k1; then with k1 again: withdraws `{"amount": "200", "currency": "EUR"}` from A1, withdraws `{"amount": "abc", "currency": "EUR"}` from A1, transfers "100" EUR from A1 to B1, and withdraws `{"currency":"EUR","amount":"100"}` from A1, keys reordered
- **Then** the first answers 201; the next three answer 422 with type `/problems/idempotency-key-reused`, the `amount` "abc" one included, not `/problems/validation-error`; the last answers 201 with the first's body and `Idempotent-Replayed: true`; A1 is "900" EUR and B1 "0" EUR with exactly one withdrawal transaction; and the key row of (C1, k1) holds the first response throughout

### IDM-AC10 · The same key on two replicas executes once

- **Level:** integration
- **Covers:** IDM-R06, IDM-R10
- **Given** replicas P1 and P2 started with `IDEMPOTENCY_WAIT_TIMEOUT_MS` "3000", `ACCOUNT_LOCK_TIMEOUT_MS` "4000", `REQUEST_TIMEOUT_MS` "40000" and `SHUTDOWN_TIMEOUT_MS` "40000"; A1 with "1000" EUR; and a separate database session that holds `SELECT ... FOR UPDATE` on A1's row
- **When** C1 sends a withdrawal of "100" EUR from A1 with Idempotency-Key k1 to P1 (request R1); once R1's database session is observed waiting on A1's row lock, C1 sends the same request with k1 to P2 (request R2); once R2's database session is observed blocked by R1's session (`pg_blocking_pids`), the session releases its lock; and then C1 sends 20 identical withdrawals of "100" EUR from A2, which holds "1000" EUR, with one key k2 at the same time, alternating between P1 and P2
- **Then** R1 answers 201 without the header `Idempotent-Replayed`; R2 answers 201 with a body byte for byte equal to R1's and `Idempotent-Replayed: true`; one withdrawal transaction exists for k1; of the 20 k2 requests all answer 201 with byte for byte equal bodies, exactly one without `Idempotent-Replayed`, and exactly one withdrawal transaction exists for k2; and no response is a 5xx

### IDM-AC11 · A waiting request with another fingerprint gets 422 after the first finishes

- **Level:** integration
- **Covers:** IDM-R10
- **Given** replicas P1 and P2 started with `IDEMPOTENCY_WAIT_TIMEOUT_MS` "3000", `ACCOUNT_LOCK_TIMEOUT_MS` "4000", `REQUEST_TIMEOUT_MS` "40000" and `SHUTDOWN_TIMEOUT_MS` "40000"; A1 with "1000" EUR; and a separate database session that holds `SELECT ... FOR UPDATE` on A1's row
- **When** C1 withdraws "100" EUR from A1 with Idempotency-Key k1 on P1 (R1); once R1 waits on A1's row lock, C1 withdraws "200" EUR from A1 with k1 on P2 (R2); once R2 is blocked by R1's session, the session releases its lock
- **Then** R1 answers 201; R2 answers 422 with type `/problems/idempotency-key-reused`, after R1; and A1 is "900" EUR with one withdrawal transaction

### IDM-AC12 · A waiting request runs when the first rolls back

- **Level:** integration
- **Covers:** IDM-R10, IDM-R17
- **Given** replica P1 is the test app (SYS-R37) with a fault injected after the ledger entries of a withdrawal are written, and replica P2 has no fault, both started with `IDEMPOTENCY_WAIT_TIMEOUT_MS` "3000", `ACCOUNT_LOCK_TIMEOUT_MS` "4000", `REQUEST_TIMEOUT_MS` "40000" and `SHUTDOWN_TIMEOUT_MS` "40000"; A1 with "1000" EUR; and a separate database session that holds `SELECT ... FOR UPDATE` on A1's row
- **When** C1 withdraws "100" EUR from A1 with Idempotency-Key k1 on P1 (R1); once R1 waits on A1's row lock, C1 sends the same request with k1 on P2 (R2); once R2 is blocked by R1's session, the session releases its lock
- **Then** R1 answers 500 with type `/problems/internal-error`; R2 answers 201 without the header `Idempotent-Replayed`; and A1 is "900" EUR with exactly one withdrawal transaction for k1, written by R2

### IDM-AC13 · A wait longer than the idempotency wait timeout answers 409

- **Level:** integration
- **Covers:** IDM-R06, IDM-R11, IDM-R12, SYS-R34
- **Given** the service started with `IDEMPOTENCY_WAIT_TIMEOUT_MS` "300", `ACCOUNT_LOCK_TIMEOUT_MS` "4000", `REQUEST_TIMEOUT_MS` "30000" and `SHUTDOWN_TIMEOUT_MS` "30000"; A1 with "1000" EUR; and a separate database session that holds `SELECT ... FOR UPDATE` on A1's row
- **When** C1 withdraws "100" EUR from A1 with Idempotency-Key k1 (R1); once R1 waits on A1's row lock, C1 sends the same request with k1 (R2); after R2 has answered, the session releases its lock; then C1 sends the same request with k1 again (R3)
- **Then** R2's database session is observed blocked by R1's session, not by the session holding A1's lock; R2 answers 409 with type `/problems/request-in-progress` and `Retry-After: 1` after at least 300 ms, while R1 has not answered; R1 then answers 201; R3 answers 201 with R1's body and `Idempotent-Replayed: true`; and A1 is "900" EUR with one withdrawal transaction

### IDM-AC14 · SQLSTATE 55P03 maps by step

- **Level:** unit
- **Covers:** IDM-R12, IDM-R13
- **Given** the request runner with a fake unit of work, and a database error with SQLSTATE 55P03
- **When** the error is raised by the key row insert, and then by an account row lock after the key row is inserted
- **Then** the first ends with the typed error that the HTTP error handler maps to 409 with type `/problems/request-in-progress` and `Retry-After: 1`; the second with the typed error mapped to 503 with type `/problems/service-unavailable` and `Retry-After: 1`; both roll back the whole database transaction; and neither is retried

### IDM-AC15 · A business rejection is stored and replayed after the funds arrive

- **Level:** integration
- **Covers:** IDM-R14
- **Given** A1 with "1000" EUR
- **When** C1 withdraws "1500" EUR from A1 with Idempotency-Key k1 and `X-Request-Id: r1`; O1 deposits "1000" EUR into A1; and C1 sends the same withdrawal with k1
- **Then** the first answers 422 with type `/problems/insufficient-funds` and `requestId` "r1", and afterwards the key row of (C1, k1) is committed with status 422 and that body, and no transaction, ledger entry or audit record exists for k1; the retry answers 422 with the same body, `requestId` "r1" included, and `Idempotent-Replayed: true`, although A1 now holds "2000" EUR; and A1 stays "2000" EUR with no withdrawal transaction

### IDM-AC16 · Lookup and business rejections are stored

- **Level:** integration
- **Covers:** IDM-R14
- **Given** A1 with "1000" EUR, C1's F1 `frozen` with "1000" EUR, and C2's X2 `closed` with "0" EUR; O1 deposited "1000" EUR into A1 as D
- **When** C1 withdraws "100" EUR from U with k1, withdraws "100" USD from A1 with k2, withdraws "100" EUR from F1 with k3, and transfers "100" EUR from A1 to X2 with k4; O1 reverses D with k5 and again with k6; then O1 unfreezes F1; and each of the six requests is sent again with its key
- **Then** the first answers are, in order, 404 `/problems/not-found`, 422 `/problems/currency-mismatch`, 422 `/problems/account-not-active`, 422 `/problems/destination-unavailable`, 201, and 409 `/problems/already-reversed`; each retry answers its stored status and body with `Idempotent-Replayed: true`, F1's withdrawal included although F1 is now `active`; and no movement other than D's single reversal is applied

### IDM-AC17 · A rejection raised by a database constraint is stored

- **Level:** integration
- **Covers:** IDM-R14
- **Given** the test app (SYS-R37) with the fault-injection hook of REV-AC08, which skips the check for an existing reversal; A1 with "2000" EUR after two deposits of "1000" EUR by O1, the first being D; and D reversed once, leaving A1 "1000" EUR
- **When** O1 reverses D again with Idempotency-Key k2, and then sends the same request with k2
- **Then** the hook records that it skipped the check for an existing reversal; the insert of the second reversal is refused by the unique constraint of REV-R05, with SQLSTATE 23505 on that constraint; the first request still answers 409 with type `/problems/already-reversed`, not 500, and the key row of (O1, k2) is committed with status 409 and that body; the second answers the same with `Idempotent-Replayed: true`; and A1 stays "1000" EUR with one reversal of D

### IDM-AC18 · Validation errors are not stored

- **Level:** integration
- **Covers:** IDM-R16
- **Given** A1 with "1000" EUR
- **When** C1 withdraws `{"amount": "10.50", "currency": "EUR"}` from A1 with Idempotency-Key k1, and then withdraws `{"amount": "100", "currency": "EUR"}` from A1 with k1
- **Then** the first answers 422 with type `/problems/validation-error`, and afterwards no key row of (C1, k1) exists; the second answers 201 without the header `Idempotent-Replayed`; and A1 is "900" EUR

### IDM-AC19 · Failures are not stored, and a retry executes again

- **Level:** integration
- **Covers:** IDM-R17
- **Given** the test app (SYS-R37) with a fault injected after the ledger entries of a withdrawal are written, and A1 with "1000" EUR
- **When** C1 withdraws "100" EUR from A1 with Idempotency-Key k1; then the fault is changed so that every attempt of the database transaction fails with SQLSTATE 40001, and C1 withdraws "100" EUR from A1 with k2; then the fault is removed and C1 sends both requests again with k1 and k2
- **Then** the k1 request answers 500 with type `/problems/internal-error`; the k2 request runs 3 attempts and answers 503 with type `/problems/service-unavailable`; after each, no key row, transaction, ledger entry or audit record exists for its key; both retries answer 201 without the header `Idempotent-Replayed`; and A1 is "800" EUR with one withdrawal transaction per key

### IDM-AC20 · No key row is committed without a result

- **Level:** integration
- **Covers:** IDM-R18
- **Given** the key table
- **When** a key row for user C1 and key k9 with a fingerprint but no stored status, headers or body is written directly to the database and committed; and in another database transaction the same row is inserted and then updated with status 201, headers and a body before the commit
- **Then** the first commit is rejected and no row for k9 is stored; and the second commits, with one row for k9

### IDM-AC21 · A response lost after the commit is replayed

- **Level:** integration
- **Covers:** IDM-R19
- **Given** the test app (SYS-R37) listening on a TCP port, with a hook that destroys the client connection after the database transaction of a withdrawal commits and before the response is written; A1 with "1000" EUR
- **When** C1 withdraws "100" EUR from A1 with Idempotency-Key k1 and gets a connection error; then the hook is removed and C1 sends the same request with k1
- **Then** the retry answers 201 with `balance` "900" and `Idempotent-Replayed: true`; A1 is "900" EUR; and exactly one withdrawal transaction and one audit record exist for k1

### IDM-AC22 · Keys expire after the default TTL and can be reused

- **Level:** integration
- **Covers:** IDM-R20, IDM-R21
- **Given** A1 with "1000" EUR, and C1 withdrew "100" EUR from A1 with Idempotency-Key k1, leaving A1 "900" EUR
- **When** the key row of (C1, k1) is read; then its `expiresAt` is set one second into the past directly in the database, without running the cleanup; and C1 withdraws "200" EUR from A1 with k1
- **Then** `expiresAt` minus `createdAt` is exactly 86400 seconds; the second withdrawal answers 201 without the header `Idempotent-Replayed`, not 422; A1 is "700" EUR with two withdrawal transactions; and the key row of (C1, k1) now holds the second request's fingerprint and response and an `expiresAt` 86400 seconds after its new `createdAt`

### IDM-AC23 · A configured TTL

- **Level:** integration
- **Covers:** IDM-R20
- **Given** the service started with `IDEMPOTENCY_KEY_TTL_SECONDS` "3600", and A1 with "1000" EUR
- **When** C1 withdraws "100" EUR from A1 with Idempotency-Key k1 and the key row of (C1, k1) is read
- **Then** its `expiresAt` minus its `createdAt` is exactly 3600 seconds

### IDM-AC24 · The cleanup deletes expired keys only, without waiting

- **Level:** integration
- **Covers:** IDM-R22
- **Given** a database created for this test with every migration applied; key rows of C1 for e1 and e2 with `expiresAt` in the past and for n1 with `expiresAt` in the future, each with a stored response; and a separate database session that holds `SELECT ... FOR UPDATE` on the row of e2
- **When** `npm run idempotency:cleanup` runs with `DATABASE_URL` pointing to that database while the session keeps its lock; then the session releases it and the cleanup runs again; then it runs with `DATABASE_URL` pointing to a port where no database listens
- **Then** the first run completes before the session releases its lock, deletes only e1, prints `{"deleted": 1}` and exits 0; the second deletes only e2, prints `{"deleted": 1}` and exits 0; n1 remains; the third exits 2; and no output contains the database password

### IDM-AC25 · Invalid idempotency settings stop the service from starting

- **Level:** unit
- **Covers:** IDM-R20, IDM-R23
- **Given** the configuration loader
- **When** it loads `IDEMPOTENCY_WAIT_TIMEOUT_MS` unset, "1" and "4999", and `IDEMPOTENCY_KEY_TTL_SECONDS` unset, "3600" and "2592000"; and then each variable with "0", "-1", "+5", "0500", "1e3", "10.5", "abc", "", " 500", and one above its maximum ("5000", "2592001"); and `IDEMPOTENCY_KEY_TTL_SECONDS` "3599", one below its minimum
- **Then** the first loads give 2000, 1 and 4999 milliseconds, and 86400, 3600 and 2592000 seconds; each of the others fails with a configuration error whose message names the variable, and the app is not built

## 4. Error catalogue

Errors shared by every capability are in spec 000; what each outcome stores is in section 1.3. This spec adds:

| Condition                                                                                                                                        | HTTP | Problem type                     | Stored for idempotent replay |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | -------------------------------- | ---------------------------- |
| No `Idempotency-Key` on a deposit, withdrawal, transfer or reversal; a key sent twice, empty, longer than 255 characters or not visible ASCII    | 400  | /problems/malformed-request      | no                           |
| The key matches an unexpired request of the same user with a different fingerprint                                                               | 422  | /problems/idempotency-key-reused | no                           |
| The key is held by a request in progress for longer than `IDEMPOTENCY_WAIT_TIMEOUT_MS` (SQLSTATE 55P03 at the key insert), with `Retry-After: 1` | 409  | /problems/request-in-progress    | no                           |
| `IDEMPOTENCY_WAIT_TIMEOUT_MS` or `IDEMPOTENCY_KEY_TTL_SECONDS` is invalid                                                                        | n/a  | none: the service does not start | n/a                          |

## 5. Invariants

- A request with a key is executed at most once per user and key while its key row has not expired, whatever the number of replicas and retries (IDM-AC07, IDM-AC10, IDM-AC21).
- Every committed key row holds a stored response, and that response never changes until the row expires (IDM-AC09, IDM-AC20).
- A key row is committed exactly when the request's outcome is stored, and in the same database transaction as the request's effects, if any (IDM-AC15, IDM-AC18, IDM-AC19).
- No idempotency state lives in process memory (IDM-AC10).
- The invariants of specs 000 to 004 hold before and after every operation of this spec.

## 6. Out of scope

- Idempotency for requests other than the POSTs listed: reads are safe, and status changes are idempotent by their own rules (ACC-R15); a key sent to them is ignored (SYS-R39).
- Retries after the key has expired: a request retried after `IDEMPOTENCY_KEY_TTL_SECONDS` runs again (section 1.4).
- Exposing stored responses or key rows through the API.
- Scheduling the cleanup in production: spec 008 (DEP-R37), built in phase 12-infra.
- Detecting duplicate requests sent with different keys.

## 7. Open questions

None. Every question raised while writing this spec was decided by the owner on 2026-10-07 and is stated above as a rule.
