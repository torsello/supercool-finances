# API guide

For API clients: how to authenticate, send money movements safely, page through lists and read errors. The reference for every field is the OpenAPI document, [openapi.yaml](openapi.yaml), also served with Swagger UI at `/docs` on a running stack. The endpoint table and the request lifecycle diagram are in the [README](../../README.md#api-overview), and every request below is ready to run from [requests.http](requests.http) or the [Postman collection](#postman-collection).

The examples run against the local stack of the [Quickstart](../../README.md#quickstart), from a fresh `docker compose up --build --wait`, and show real responses. Ids, timestamps and request ids differ on every run.

## Contents

- [Conventions](#conventions)
- [Authentication and roles](#authentication-and-roles)
- [Idempotency-Key](#idempotency-key)
- [Pagination](#pagination)
- [Endpoints](#endpoints)
- [Errors](#errors)
- [Postman collection](#postman-collection)

## Conventions

| Topic        | Rule                                                                                                                                                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base path    | Every endpoint is under `/v1`. The health checks (`/health/live`, `/health/ready`) and the documentation (`/docs`, `/docs/json`) are outside it and need no token.                                                                |
| Bodies       | `Content-Type: application/json` (UTF-8), at most 16384 bytes. Unknown members are refused with 422.                                                                                                                              |
| Amounts      | Strings of decimal digits in minor units, never JSON numbers ([ADR-0011](../adr/0011-amounts-as-strings-in-the-api-and-bigint-in-the-domain.md)): `"1050"` is 10.50 EUR. A ledger entry's amount is signed: `"-1050"` is a debit. |
| Currencies   | `USD`, `MXN`, `EUR` and `COP` have 2 decimal places; `JPY` has none, so `"1050"` JPY is 1050 yen. A deposit, withdrawal or transfer is at most `MAX_AMOUNT_MINOR` (100000000000 by default).                                      |
| Ids          | UUIDv7 strings. An id in the path that is not a UUID answers 404, as an unknown one does.                                                                                                                                         |
| Timestamps   | RFC 3339 in UTC with milliseconds: `"2026-10-09T14:00:16.995Z"`.                                                                                                                                                                  |
| Every answer | carries `X-Request-Id`: yours when it matches `[A-Za-z0-9._:-]{1,128}`, otherwise a generated one. Quote it when reporting a problem.                                                                                             |

## Authentication and roles

Every `/v1` request carries `Authorization: Bearer <JWT>`. The token is signed with HS256 and carries `sub` (the user's id, a UUID), `role` (`customer` or `operator`), `iat`, `exp` at most 15 minutes after `iat`, and the `iss` and `aud` the service is configured with. Each replica verifies it alone, from the token and its configuration. A missing, expired or otherwise invalid token answers 401 `/problems/unauthenticated`, and the answer never says which check failed.

The service issues no tokens: authentication is simulated ([ADR-0012](../adr/0012-simulated-authentication-with-jwt-and-two-roles.md)). Locally, `make token SUB=<uuid> ROLE=<role>` (or `npm run token -- --sub <uuid> --role <role>`) mints one with the stack's demo secret.

| Role       | May                                                                                                                                                                   |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `customer` | Open, list and read their own accounts and their history; withdraw and transfer from them; read transactions on them.                                                 |
| `operator` | Read any customer account by id, with its `ownerId`, and its history; deposit; freeze, unfreeze and close; read any transaction; reverse. Operators list no accounts. |

An operation the role does not have answers 403 `/problems/forbidden`, whatever ids the request names. Another customer's account or transaction answers 404 `/problems/not-found`, exactly as an unknown id does, and so does a system account, for operators too. The full matrix is table 1.3 of [spec 006](../../specs/006-auth/spec.md).

## Idempotency-Key

Deposits, withdrawals, transfers and reversals require an `Idempotency-Key` header; account creation accepts one. The other endpoints ignore it. Use a fresh value, such as a UUID, for each logical operation, and send the same value again only to retry that operation ([spec 005](../../specs/005-idempotency/spec.md), [ADR-0009](../adr/0009-idempotency-inside-the-movements-transaction.md)).

- **Format:** 1 to 255 visible ASCII characters, sent once. Keys are scoped to the user of the token and compared exactly.
- **Fingerprint:** the method, the path and the body, canonicalized, so key order and whitespace do not matter. The query string is not part of it.
- **Replay:** a repeat with the same key and fingerprint within `IDEMPOTENCY_KEY_TTL_SECONDS` (24 hours by default) gets the stored status, `Content-Type`, `Location` and body, byte for byte, including the original `requestId`, with this request's `X-Request-Id` and `Idempotent-Replayed: true`. It moves no money and works on any replica, because the key lives in PostgreSQL.
- **Concurrent repeat:** a repeat that arrives while the first request is still running waits for it, at most `IDEMPOTENCY_WAIT_TIMEOUT_MS` (2000 ms by default), then replays its response, or answers 409 `/problems/request-in-progress` with `Retry-After: 1`.
- **Misuse:** the same key with another method, path or body answers 422 `/problems/idempotency-key-reused`.
- **Expiry:** after the TTL the key is forgotten, and a request with it runs as a new one. Retry within the TTL only.

What a retry gets depends on what the first attempt was answered:

| First answer                                                                                                                                                                                                | Stored? | A retry with the same key                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------- |
| 201                                                                                                                                                                                                         | yes     | the same 201, replayed                                   |
| 404 for the resource in the path; a business rejection (409 `already-reversed`, 422 `insufficient-funds` and the other rule types)                                                                          | yes     | the same answer, replayed                                |
| 422 `validation-error`, 422 `idempotency-key-reused`, 409 `request-in-progress`                                                                                                                             | no      | runs again                                               |
| 400, 401, 403, 413, 415, 429                                                                                                                                                                                | no      | runs again                                               |
| Any other 503 `service-unavailable`, 500                                                                                                                                                                    | no      | runs again: nothing was committed                        |
| 503 `service-unavailable` for a connection lost during `COMMIT`, a 503 for the request timeout after `COMMIT`, 502, 503 or 504 `upstream-unavailable` from the load balancer, a connection error, a timeout | unknown | the stored answer if the first committed, otherwise runs |

**Retry policy for clients.** On a connection error, a 502, 503 or 504, or a 409 `/problems/request-in-progress`, send the same request with the same key again. Wait for the response's `Retry-After`, or 200 ms when it has none, and stop after 60 attempts. Never retry any other 4xx: fix the request, or use a new key for a new operation. This is the policy the e2e test of losing a replica uses (section 1.5 of [spec 008](../../specs/008-deployment/spec.md), DEP-AC11).

## Pagination

`GET /v1/accounts` and `GET /v1/accounts/{id}/entries` return one page, newest first by (`createdAt`, `id`), as `{"items": [...], "nextCursor": "..."}` ([ADR-0017](../adr/0017-keyset-pagination-with-signed-cursors.md)).

- `limit` is an integer from 1 to 100, and 20 when absent; anything else answers 422.
- `nextCursor` is absent on the last page. Pass it back unchanged as `cursor` to get the next page; any replica accepts it.
- A cursor is opaque and signed with `CURSOR_SECRET`. One that was altered, or was issued for another list or user, answers 400 `/problems/malformed-request`.
- Pages are keyset-based, so an item created while you page never makes another one repeat or disappear.

## Endpoints

Set the variables once, from the root of the repository. `make demo-env` runs the seed (which changes nothing when it already ran) and prints `TOKEN` (demo-customer-1), `OPERATOR_TOKEN` (demo-operator), and `A` and `B`, the EUR accounts of demo-customer-1 and demo-customer-2. The two shell functions keep the examples short: `call` prints the status line, the headers that matter and the body, and keeps the body's `id` in `ID`.

```sh
eval "$(make demo-env)"
BASE=http://localhost:8080
call() {
  local out
  out=$(curl -si "$@")
  printf '%s\n' "$out" | grep -iE '^(HTTP/|content-type|location|retry-after|idempotent-replayed|www-authenticate)|^\{'
  ID=$(printf '%s\n' "$out" | sed -n 's/^{"id":"\([^"]*\)".*/\1/p')
}
```

### Health

`GET /health/live` checks only that the process runs; `GET /health/ready` checks the database and the migrations ([observability](../observability.md#health-endpoints)).

```sh
call $BASE/health/live
call $BASE/health/ready
```

```text
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
{"status":"ok"}
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
{"status":"ready"}
```

### Open an account

`POST /v1/accounts`, customer. Body: `currency`. An `Idempotency-Key` is optional. Answers 201 with `Location`.

```sh
call -X POST $BASE/v1/accounts -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: docs-open-cop-1' -d '{"currency": "COP"}'
C=$ID
```

```text
HTTP/1.1 201 Created
Content-Type: application/json; charset=utf-8
location: /v1/accounts/01a12126-dbe3-7510-872d-e1aea0094766
{"id":"01a12126-dbe3-7510-872d-e1aea0094766","currency":"COP","status":"active","balance":"0","createdAt":"2026-10-09T14:52:37.218Z","updatedAt":"2026-10-09T14:52:37.218Z"}
```

### List your accounts

`GET /v1/accounts?limit=&cursor=`, customer. Every status is listed.

```sh
call "$BASE/v1/accounts?limit=2" -H "Authorization: Bearer $TOKEN"
CURSOR=$(curl -s "$BASE/v1/accounts?limit=2" -H "Authorization: Bearer $TOKEN" | sed -n 's/.*"nextCursor":"\([^"]*\)".*/\1/p')
call "$BASE/v1/accounts?limit=2&cursor=$CURSOR" -H "Authorization: Bearer $TOKEN"
```

```text
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
{"items":[{"id":"01a12126-dbe3-7510-872d-e1aea0094766","currency":"COP","status":"active","balance":"0","createdAt":"2026-10-09T14:52:37.218Z","updatedAt":"2026-10-09T14:52:37.218Z"},{"id":"01a12126-dace-77e5-939e-a334d298417a","currency":"USD","status":"active","balance":"100000","createdAt":"2026-10-09T14:52:36.941Z","updatedAt":"2026-10-09T14:52:36.949Z"}],"nextCursor":"eyJsIjoiYWNjb3VudHMiLCJ1IjoiMDE5MmYwYTAtMDAwMC03MDAwLTgwMDAtMDAwMDAwMDBkMGMxIiwidCI6IjIwMjYtMTAtMDlUMTQ6NTI6MzYuOTQxNjgxWiIsImkiOiIwMWExMjEyNi1kYWNlLTc3ZTUtOTM5ZS1hMzM0ZDI5ODQxN2EifRh-p3rpEoP_CYnI3Dx-1uSedRuGWU_zm8Al0qSvCWTP"}
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
{"items":[{"id":"01a12126-dab2-768b-badc-2cb8c8b645a1","currency":"EUR","status":"active","balance":"250000","createdAt":"2026-10-09T14:52:36.909Z","updatedAt":"2026-10-09T14:52:36.933Z"}]}
```

### Read an account

`GET /v1/accounts/{id}`, customer (own accounts) or operator (any customer account, with `ownerId`).

```sh
call $BASE/v1/accounts/$A -H "Authorization: Bearer $TOKEN"
call $BASE/v1/accounts/$A -H "Authorization: Bearer $OPERATOR_TOKEN"
```

```text
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
{"id":"01a12126-dab2-768b-badc-2cb8c8b645a1","currency":"EUR","status":"active","balance":"250000","createdAt":"2026-10-09T14:52:36.909Z","updatedAt":"2026-10-09T14:52:36.933Z"}
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
{"id":"01a12126-dab2-768b-badc-2cb8c8b645a1","currency":"EUR","status":"active","balance":"250000","createdAt":"2026-10-09T14:52:36.909Z","updatedAt":"2026-10-09T14:52:36.933Z","ownerId":"0192f0a0-0000-7000-8000-00000000d0c1"}
```

### Deposit

`POST /v1/accounts/{id}/deposits`, operator. Body: `amount`, `currency`. `Idempotency-Key` required. The money comes from the settlement account of the currency.

```sh
call -X POST $BASE/v1/accounts/$A/deposits -H "Authorization: Bearer $OPERATOR_TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: docs-deposit-1' -d '{"amount": "5000", "currency": "EUR"}'
DEPOSIT=$ID
```

```text
HTTP/1.1 201 Created
Content-Type: application/json; charset=utf-8
location: /v1/transactions/01a12126-dc49-7187-8274-85e4fe334e84
{"id":"01a12126-dc49-7187-8274-85e4fe334e84","kind":"deposit","amount":"5000","currency":"EUR","createdAt":"2026-10-09T14:52:37.322Z"}
```

### Withdraw

`POST /v1/accounts/{id}/withdrawals`, customer, from their own account. Body: `amount`, `currency`. `Idempotency-Key` required. Answers with the account's new balance.

```sh
call -X POST $BASE/v1/accounts/$A/withdrawals -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: withdrawal-1' -d '{"amount": "2000", "currency": "EUR"}'
```

```text
HTTP/1.1 201 Created
Content-Type: application/json; charset=utf-8
location: /v1/transactions/01a12126-dbb3-7459-b0ee-99bbfe9ec7e0
{"id":"01a12126-dbb3-7459-b0ee-99bbfe9ec7e0","kind":"withdrawal","amount":"2000","currency":"EUR","createdAt":"2026-10-09T14:52:37.171Z","accountId":"01a12126-dab2-768b-badc-2cb8c8b645a1","balance":"253000"}
```

### Transfer

`POST /v1/accounts/{id}/transfers`, customer, from their own account. Body: `destinationAccountId`, `amount`, `currency`. `Idempotency-Key` required. The destination may be any active customer account in the same currency, and the answer carries the source's new balance.

```sh
call -X POST $BASE/v1/accounts/$A/transfers -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: docs-transfer-1' \
  -d "{\"destinationAccountId\": \"$B\", \"amount\": \"1050\", \"currency\": \"EUR\"}"
TRANSFER=$ID
```

```text
HTTP/1.1 201 Created
Content-Type: application/json; charset=utf-8
location: /v1/transactions/01a12126-dc4a-76ee-9f8b-fe6516197f00
{"id":"01a12126-dc4a-76ee-9f8b-fe6516197f00","kind":"transfer","amount":"1050","currency":"EUR","createdAt":"2026-10-09T14:52:37.199Z","accountId":"01a12126-dab2-768b-badc-2cb8c8b645a1","balance":"251950"}
```

The same request again, as a client would send it after a timeout, is replayed:

```sh
call -X POST $BASE/v1/accounts/$A/transfers -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: docs-transfer-1' \
  -d "{\"destinationAccountId\": \"$B\", \"amount\": \"1050\", \"currency\": \"EUR\"}"
```

```text
HTTP/1.1 201 Created
Content-Type: application/json; charset=utf-8
location: /v1/transactions/01a12126-dc4a-76ee-9f8b-fe6516197f00
idempotent-replayed: true
{"id":"01a12126-dc4a-76ee-9f8b-fe6516197f00","kind":"transfer","amount":"1050","currency":"EUR","createdAt":"2026-10-09T14:52:37.199Z","accountId":"01a12126-dab2-768b-badc-2cb8c8b645a1","balance":"251950"}
```

### Read an account's history

`GET /v1/accounts/{id}/entries?limit=&cursor=`, customer (own accounts) or operator. Each entry is signed: negative debits the account.

```sh
call "$BASE/v1/accounts/$A/entries?limit=2" -H "Authorization: Bearer $TOKEN"
```

```text
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
{"items":[{"id":"01a12126-dc4a-76ee-9f8b-f0ea4748ed06","transactionId":"01a12126-dc49-7187-8274-85e4fe334e84","kind":"deposit","amount":"5000","currency":"EUR","createdAt":"2026-10-09T14:52:37.322Z"},{"id":"01a12126-dc4a-76ee-9f8c-016076f1e025","transactionId":"01a12126-dc4a-76ee-9f8b-fe6516197f00","kind":"transfer","amount":"-1050","currency":"EUR","createdAt":"2026-10-09T14:52:37.200Z"}],"nextCursor":"eyJsIjoiZW50cmllcyIsInUiOiIwMTkyZjBhMC0wMDAwLTcwMDAtODAwMC0wMDAwMDAwMGQwYzEiLCJhIjoiMDFhMTIxMjYtZGFiMi03NjhiLWJhZGMtMmNiOGM4YjY0NWExIiwidCI6IjIwMjYtMTAtMDlUMTQ6NTI6MzcuMjAwMTAxWiIsImkiOiIwMWExMjEyNi1kYzRhLTc2ZWUtOWY4Yy0wMTYwNzZmMWUwMjUifefOrEItdnOaGtOQBwwGr7rwrOmIzbjmLCecBoUWNObx"}
```

### Read a transaction

`GET /v1/transactions/{id}`, customer (a transaction on one of their accounts) or operator. A customer sees only the entries of their own accounts, so the receiver of a transfer never learns the sender's account; an operator sees every entry, settlement accounts included.

```sh
call $BASE/v1/transactions/$TRANSFER -H "Authorization: Bearer $TOKEN"
call $BASE/v1/transactions/$DEPOSIT -H "Authorization: Bearer $OPERATOR_TOKEN"
```

```text
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
{"id":"01a12126-dc4a-76ee-9f8b-fe6516197f00","kind":"transfer","amount":"1050","currency":"EUR","createdAt":"2026-10-09T14:52:37.199Z","entries":[{"accountId":"01a12126-dab2-768b-badc-2cb8c8b645a1","amount":"-1050"}]}
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
{"id":"01a12126-dc49-7187-8274-85e4fe334e84","kind":"deposit","amount":"5000","currency":"EUR","createdAt":"2026-10-09T14:52:37.322Z","entries":[{"accountId":"01a12126-dab2-768b-badc-2cb8c8b645a1","amount":"5000"},{"accountId":"01a11bd5-1bfc-73c6-a32f-b7dbf9a42bae","amount":"-5000"}]}
```

### Reverse a transaction

`POST /v1/transactions/{id}/reversals`, operator. Body: `reason`, 3 to 500 characters, stored and audited but never returned. `Idempotency-Key` required. The reversal is a new transaction with every entry of the original negated ([spec 004](../../specs/004-reversals/spec.md)).

```sh
call -X POST $BASE/v1/transactions/$DEPOSIT/reversals -H "Authorization: Bearer $OPERATOR_TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: docs-reversal-1' -d '{"reason": "Deposit credited to the wrong account"}'
REVERSAL=$ID
```

```text
HTTP/1.1 201 Created
Content-Type: application/json; charset=utf-8
location: /v1/transactions/01a12126-dc2d-761b-978c-5998bc1edc8d
{"id":"01a12126-dc2d-761b-978c-5998bc1edc8d","kind":"reversal","amount":"5000","currency":"EUR","createdAt":"2026-10-09T14:52:37.294Z","reversedTransactionId":"01a12126-dc49-7187-8274-85e4fe334e84"}
```

### Freeze, unfreeze and close

`POST /v1/accounts/{id}/freeze`, `/unfreeze` and `/close`, operator, with no body or an empty JSON object. No `Idempotency-Key`. Only an account with balance "0" can be closed, and `closed` is final.

```sh
call -X POST $BASE/v1/accounts/$C/freeze -H "Authorization: Bearer $OPERATOR_TOKEN"
call -X POST $BASE/v1/accounts/$C/unfreeze -H "Authorization: Bearer $OPERATOR_TOKEN"
call -X POST $BASE/v1/accounts/$C/close -H "Authorization: Bearer $OPERATOR_TOKEN"
```

```text
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
{"id":"01a12126-dbe3-7510-872d-e1aea0094766","currency":"COP","status":"frozen","balance":"0","createdAt":"2026-10-09T14:52:37.218Z","updatedAt":"2026-10-09T14:52:37.314Z","ownerId":"0192f0a0-0000-7000-8000-00000000d0c1"}
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
{"id":"01a12126-dbe3-7510-872d-e1aea0094766","currency":"COP","status":"active","balance":"0","createdAt":"2026-10-09T14:52:37.218Z","updatedAt":"2026-10-09T14:52:37.333Z","ownerId":"0192f0a0-0000-7000-8000-00000000d0c1"}
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
{"id":"01a12126-dbe3-7510-872d-e1aea0094766","currency":"COP","status":"closed","balance":"0","createdAt":"2026-10-09T14:52:37.218Z","updatedAt":"2026-10-09T14:52:37.351Z","ownerId":"0192f0a0-0000-7000-8000-00000000d0c1"}
```

## Errors

Every error is `application/problem+json` (RFC 9457, [ADR-0016](../adr/0016-error-model.md)) with `type`, `title`, `status`, `detail` and `requestId`, plus `errors` for a validation error, with one entry per field. `title` and `detail` are fixed per type, so match on `type`. No body holds a stack trace, SQL or an internal message.

Checks run in one order, and the first failure answers: route, authentication, per-user rate limit, role, media type, body size, malformed request, idempotency, validation, lookup, business rules ([request lifecycle](../../README.md#request-lifecycle)).

| Status        | Type (`/problems/...`)            | When                                                                                                                                                                        | Retry with the same key? |
| ------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 400           | `malformed-request`               | The body is not JSON; `Idempotency-Key` missing on a movement, sent twice, empty, over 255 characters or not visible ASCII; an altered or foreign cursor                    | no                       |
| 401           | `unauthenticated`                 | No token, or a token that fails any check                                                                                                                                   | no                       |
| 403           | `forbidden`                       | The role is not allowed the operation, whatever ids it names                                                                                                                | no                       |
| 404           | `not-found`                       | An unknown route; an account or transaction that does not exist, is another customer's or a system account, or whose id is not a UUID                                       | no                       |
| 409           | `already-reversed`                | The transaction already has a reversal                                                                                                                                      | no                       |
| 409           | `invalid-status-transition`       | Freezing or unfreezing a closed account                                                                                                                                     | no                       |
| 409           | `account-balance-not-zero`        | Closing an account whose balance is not "0"                                                                                                                                 | no                       |
| 409           | `request-in-progress`             | The same key is still running after `IDEMPOTENCY_WAIT_TIMEOUT_MS`; with `Retry-After: 1`                                                                                    | **yes**                  |
| 413           | `payload-too-large`               | A body over 16384 bytes (over 32 KB, answered by the load balancer)                                                                                                         | no                       |
| 415           | `unsupported-media-type`          | A body whose `Content-Type` is missing or not `application/json`                                                                                                            | no                       |
| 422           | `validation-error`                | A missing, unknown or malformed field or query parameter, an amount above the maximum, a transfer to its own source                                                         | no                       |
| 422           | `idempotency-key-reused`          | The key was used for a different request                                                                                                                                    | no                       |
| 422           | `currency-mismatch`               | The currency differs from the account's, or from an own destination's                                                                                                       | no                       |
| 422           | `account-not-active`              | The account in the path, or an own destination, is frozen or closed; for a reversal, a closed account                                                                       | no                       |
| 422           | `insufficient-funds`              | The amount is greater than the balance debited                                                                                                                              | no                       |
| 422           | `destination-unavailable`         | Another customer's destination cannot be credited, for any reason (unknown, system, frozen, closed, other currency, balance limit)                                          | no                       |
| 422           | `balance-limit-exceeded`          | A deposit or reversal would take a balance above 9223372036854775807                                                                                                        | no                       |
| 422           | `transaction-not-reversible`      | The transaction is itself a reversal                                                                                                                                        | no                       |
| 422           | `insufficient-funds-for-reversal` | The reversal would debit a customer account by more than its balance                                                                                                        | no                       |
| 429           | `rate-limited`                    | The per-IP limit at the load balancer, or the per-user limit in Redis; with `Retry-After`                                                                                   | after `Retry-After`      |
| 500           | `internal-error`                  | Any failure nothing else covers; nothing was committed                                                                                                                      | no                       |
| 502, 503, 504 | `upstream-unavailable`            | The load balancer got no answer from a replica; with `Retry-After: 1`; the outcome of a POST is unknown                                                                     | **yes**                  |
| 503           | `service-unavailable`             | A lock, pool or statement timeout, retries exhausted, the request timeout, a database connection lost during the request, or a replica shutting down; with `Retry-After: 1` | **yes**                  |

The full catalogue, with what is stored for replay, is section 4 of [spec 000](../../specs/000-overview/spec.md) and section 4 of each capability spec; the [timeouts runbook](../runbooks/timeouts-and-503.md) explains each 503. Some real answers, continuing the examples above:

```sh
call $BASE/v1/accounts                                                   # no token
call -X POST $BASE/v1/accounts/$A/deposits -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: docs-403' -d '{"amount": "100", "currency": "EUR"}'   # a customer deposits
call $BASE/v1/accounts/$B -H "Authorization: Bearer $TOKEN"              # another customer's account
call -X POST $BASE/v1/accounts/$A/withdrawals -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"amount": "100", "currency": "EUR"}'                              # no Idempotency-Key
call -X POST $BASE/v1/accounts/$A/withdrawals -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: text/plain' -H 'Idempotency-Key: docs-415' -d 'amount=100'
```

```text
HTTP/1.1 401 Unauthorized
Content-Type: application/problem+json
www-authenticate: Bearer realm="supercool-finances"
{"type":"/problems/unauthenticated","title":"Unauthenticated","status":401,"detail":"A valid bearer token is required.","requestId":"ca208d02bec0dedc18d12f60807b29c7"}
HTTP/1.1 403 Forbidden
Content-Type: application/problem+json
{"type":"/problems/forbidden","title":"Forbidden","status":403,"detail":"Your role is not permitted this operation.","requestId":"395769cccde6d687424d837750d509a5"}
HTTP/1.1 404 Not Found
Content-Type: application/problem+json
{"type":"/problems/not-found","title":"Not Found","status":404,"detail":"The requested resource does not exist.","requestId":"bf40d6b753d219a982fe692bc88029f1"}
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json
{"type":"/problems/malformed-request","title":"Malformed Request","status":400,"detail":"The Idempotency-Key header is missing or malformed.","requestId":"cfdb47634bd9efb49054a678c0921f61"}
HTTP/1.1 415 Unsupported Media Type
Content-Type: application/problem+json
{"type":"/problems/unsupported-media-type","title":"Unsupported Media Type","status":415,"detail":"The request body must be application/json, in UTF-8.","requestId":"74157af02640e5987f000cb3752e7c4e"}
```

```sh
call -X POST $BASE/v1/accounts/$A/withdrawals -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: docs-422' -d '{"amount": "10.50", "currency": "EUR"}'
call -X POST $BASE/v1/accounts/$A/transfers -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: docs-transfer-1' \
  -d "{\"destinationAccountId\": \"$B\", \"amount\": \"2000\", \"currency\": \"EUR\"}"
call -X POST $BASE/v1/accounts/$A/withdrawals -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: docs-insufficient' -d '{"amount": "99999999", "currency": "EUR"}'
call -X POST $BASE/v1/accounts/$A/withdrawals -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: docs-mismatch' -d '{"amount": "100", "currency": "USD"}'
```

```text
HTTP/1.1 422 Unprocessable Entity
Content-Type: application/problem+json
{"type":"/problems/validation-error","title":"Validation Error","status":422,"detail":"The request content is not valid; see errors.","requestId":"c5c7671b3d09212f5e21ef324268129a","errors":[{"pointer":"/amount","detail":"Must be a string of decimal digits without sign, leading zero, separator or exponent, from 1 to 9223372036854775807 minor units."}]}
HTTP/1.1 422 Unprocessable Entity
Content-Type: application/problem+json
{"type":"/problems/idempotency-key-reused","title":"Idempotency Key Reused","status":422,"detail":"This Idempotency-Key was already used for a different request.","requestId":"4467cf1113f680a57993acd32b4c1b08"}
HTTP/1.1 422 Unprocessable Entity
Content-Type: application/problem+json
{"type":"/problems/insufficient-funds","title":"Insufficient Funds","status":422,"detail":"The account balance does not cover the amount.","requestId":"623ccb7a13ddb67021cc6bdc296bb7ca"}
HTTP/1.1 422 Unprocessable Entity
Content-Type: application/problem+json
{"type":"/problems/currency-mismatch","title":"Currency Mismatch","status":422,"detail":"The currency does not match the account's currency.","requestId":"9f3acb09e5989d54b45b7d9dda84fb96"}
```

```sh
call -X POST $BASE/v1/accounts/$A/transfers -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: docs-destination' \
  -d '{"destinationAccountId": "01a120f6-0000-7000-8000-000000000000", "amount": "100", "currency": "EUR"}'
call -X POST $BASE/v1/accounts/$C/deposits -H "Authorization: Bearer $OPERATOR_TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: docs-closed' -d '{"amount": "100", "currency": "COP"}'
call -X POST $BASE/v1/transactions/$DEPOSIT/reversals -H "Authorization: Bearer $OPERATOR_TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: docs-reversal-2' -d '{"reason": "Second attempt"}'
call -X POST $BASE/v1/transactions/$REVERSAL/reversals -H "Authorization: Bearer $OPERATOR_TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: docs-reversal-3' -d '{"reason": "Undo the correction"}'
```

```text
HTTP/1.1 422 Unprocessable Entity
Content-Type: application/problem+json
{"type":"/problems/destination-unavailable","title":"Destination Unavailable","status":422,"detail":"The destination account cannot receive this transfer.","requestId":"5b728bd0915dbde987d56d6dee6052d0"}
HTTP/1.1 422 Unprocessable Entity
Content-Type: application/problem+json
{"type":"/problems/account-not-active","title":"Account Not Active","status":422,"detail":"The account is frozen or closed.","requestId":"89d2ef6740025a44921984ba9b2fd05b"}
HTTP/1.1 409 Conflict
Content-Type: application/problem+json
{"type":"/problems/already-reversed","title":"Already Reversed","status":409,"detail":"The transaction has already been reversed.","requestId":"74f52dd6dd81d6ce6e480fa6a9ff9784"}
HTTP/1.1 422 Unprocessable Entity
Content-Type: application/problem+json
{"type":"/problems/transaction-not-reversible","title":"Transaction Not Reversible","status":422,"detail":"A reversal cannot be reversed.","requestId":"8d187c2de5c60b61f518729379d3382a"}
```

## Postman collection

[postman/supercool-finances.postman_collection.json](postman/supercool-finances.postman_collection.json) (format v2.1) and [postman/local.postman_environment.json](postman/local.postman_environment.json) try every endpoint by hand, in the order a reviewer would: health and docs, accounts, money movements, idempotency, reversals, account status and errors (section 1.11 of [spec 008](../../specs/008-deployment/spec.md)). Nothing needs copying: the collection's pre-request script mints fresh 15-minute tokens for demo-customer-1, demo-customer-2 and demo-operator before each request, with the demo JWT settings the environment holds, and each request saves the ids it creates for the next ones.

1. Start and seed the stack: `docker compose up --build --wait`, then `make seed`.
2. Import both files: in Postman, **Import** and drop them; in Insomnia, **Import** each file; in Bruno, **Import Collection**, then **Postman Collection**, and add the environment's variables to a Bruno environment.
3. Select the environment "SuperCool Finances (local)" and run the collection: in Postman, **Run collection**. Every request has tests for its status and key headers, and the run passes from top to bottom, and again on the same stack.

From the command line, with Node, the same run the e2e test of DEP-AC38 makes:

```sh
npx --yes newman@6.2.3 run docs/api/postman/supercool-finances.postman_collection.json \
  --environment docs/api/postman/local.postman_environment.json | tail -19
```

```text
┌─────────────────────────┬─────────────────┬─────────────────┐
│                         │        executed │          failed │
├─────────────────────────┼─────────────────┼─────────────────┤
│              iterations │               1 │               0 │
├─────────────────────────┼─────────────────┼─────────────────┤
│                requests │              32 │               0 │
├─────────────────────────┼─────────────────┼─────────────────┤
│            test-scripts │              64 │               0 │
├─────────────────────────┼─────────────────┼─────────────────┤
│      prerequest-scripts │              33 │               0 │
├─────────────────────────┼─────────────────┼─────────────────┤
│              assertions │             107 │               0 │
├─────────────────────────┴─────────────────┴─────────────────┤
│ total run duration: 596ms                                   │
├─────────────────────────────────────────────────────────────┤
│ total data received: 198.17kB (approx)                      │
├─────────────────────────────────────────────────────────────┤
│ average response time: 4ms [min: 1ms, max: 16ms, s.d.: 2ms] │
└─────────────────────────────────────────────────────────────┘
```
