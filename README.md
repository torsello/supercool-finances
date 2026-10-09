# SuperCool Finances

Balance service for SuperCool Finances: customer accounts, a double-entry ledger and money movements.

[![CI](https://github.com/torsello/supercool-finances/actions/workflows/ci.yml/badge.svg)](https://github.com/torsello/supercool-finances/actions/workflows/ci.yml)

## Quick start

### Run it with Docker only

Prerequisite: Docker Engine 24 or later with Compose v2.20 or later. No Node, no `.env` file: `compose.yaml` holds visibly fake demo values, which the service refuses when `NODE_ENV` is `production`.

```sh
# Build the image and start Postgres, Redis, the migrations, two replicas and nginx;
# returns once every service is healthy. The API is on http://localhost:8080 (Swagger UI at /docs).
docker compose up --build --wait

# Create the demo users' accounts and deposits through the API, and print them as JSON.
# Running it again changes nothing. Each tools command first rebuilds the tools image
# (from the cache when nothing changed), so it never runs older sources than the stack.
docker compose build --quiet tools && docker compose run --rm tools npm run --silent seed

# Mint a token for demo-customer-1 and list their accounts (2500.00 EUR and 1000.00 USD).
TOKEN=$(docker compose build --quiet tools && docker compose run --rm tools npm run --silent token -- --sub 0192f0a0-0000-7000-8000-00000000d0c1 --role customer)
curl -s http://localhost:8080/v1/accounts -H "Authorization: Bearer $TOKEN"

# Transfer 10.50 EUR from one of their accounts to another account in EUR: use the ids printed by the seed.
curl -s -X POST http://localhost:8080/v1/accounts/<EUR account id>/transfers \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: my-first-transfer' \
  -d '{"destinationAccountId": "<destination account id>", "amount": "1050", "currency": "EUR"}'

# Check every balance against the ledger, then stop the stack (add -v to delete the database).
docker compose build --quiet tools && docker compose run --rm tools npm run --silent reconcile
docker compose down
```

The demo users are `demo-operator` (`0192f0a0-0000-7000-8000-00000000d0f1`, role `operator`) and `demo-customer-1` to `demo-customer-3` (`0192f0a0-0000-7000-8000-00000000d0c1` to `...d0c3`, role `customer`); a token is valid for 15 minutes. nginx balances requests round robin over `api-1` and `api-2`, and every log line of a replica carries its `replicaId`, so `docker compose logs api-1 api-2` shows which replica served each `X-Request-Id`. Only `127.0.0.1` is published: nginx on 8080, the replicas on 3001 and 3002, Postgres on 55432 and Redis on 6379.

The stack's network is `10.210.0.0/24`, with nginx at the fixed address `10.210.0.10`, the only one the replicas trust for `X-Forwarded-For`, and the replicas at `10.210.0.11` and `10.210.0.12`. If another network of the host already uses that range, `docker compose up` fails with `invalid pool request: Pool overlaps with other one on this address space`. Then set `SCF_SUBNET_PREFIX` to three other octets, for example `SCF_SUBNET_PREFIX=10.211.0 docker compose up --build --wait` (and the same variable for every later command of that stack, or once in a `.env` file); it moves the subnet, the fixed addresses and the trusted address together.

With `make`, the same commands are `make up`, `make seed`, `make token` (or `make token SUB=<uuid> ROLE=operator`), `make reconcile`, `make logs` and `make down`; `make test` runs the whole suite in the tools image: `npm run check`, the integration tests against the stack's Postgres and Redis, and `npm run trace -- --require unit,integration`.

### Develop on the host

Prerequisites: Node 24 (the version in `.nvmrc`, for example with `nvm use`) and Docker.

```sh
npm ci
npm run env:sync          # creates .env from .env.example, with random secrets
npm run infra:up          # starts Postgres and Redis
npm run migrate:up        # applies migrations/ to the dev database as the owner role scf_owner
npm run check             # typecheck, lint, format check and unit tests
npm run test:integration  # integration tests against Postgres and Redis
npm run trace             # every acceptance criterion in specs/ with the test that proves it
```

Every behaviour is specified before it is built: the specs, with their requirements and acceptance criteria, are in [`specs/`](specs/README.md), and `npm run trace` fails when an acceptance criterion that must be proven has no passing test.

## API

Every endpoint is served under `/v1` and needs `Authorization: Bearer <JWT>` with the role `customer` or `operator` (`npm run token -- --sub <uuid> --role customer` prints one for local use). Swagger UI is at `/docs` and the OpenAPI document at `/docs/json`, without credentials; the same document is committed as [`docs/api/openapi.yaml`](docs/api/openapi.yaml), regenerated with `npm run openapi:export` and linted with `npm run openapi:lint`. The committed file is generated with the default settings, while `/docs/json` shows the running values of `MAX_AMOUNT_MINOR` and `IDEMPOTENCY_KEY_TTL_SECONDS`. Every error is `application/problem+json` (RFC 9457), and every response carries an `X-Request-Id`.

## Accounts

A customer opens accounts in one of USD, MXN, EUR, COP or JPY (`POST /v1/accounts`), lists their own (`GET /v1/accounts`) and reads each one with its balance and history (`GET /v1/accounts/{id}`, `GET /v1/accounts/{id}/entries`). An operator reads any customer account by id, with its `ownerId`, but lists none. Another customer's account, a system account and an unknown id all answer the same 404.

Lists go newest first, `limit` from 1 to 100 (20 by default), and continue with the opaque `nextCursor`, which is signed with `CURSOR_SECRET`, accepted by every replica, and valid only for the list and user it was issued to.

An account is `active`, `frozen` or `closed`. Operators freeze, unfreeze and close accounts (`POST /v1/accounts/{id}/freeze`, `/unfreeze`, `/close`); only an account with balance "0" can be closed, and `closed` is final. A frozen or closed account takes no deposit, withdrawal or transfer on either side; a reversal is still allowed on a frozen account. Spec: [`specs/001-accounts`](specs/001-accounts/spec.md).

## Ledger

Every money movement is one transaction of two or more ledger entries that sum to zero, in one currency, written in the same database transaction as the balance changes. Amounts are integers in minor units of the currency: `bigint` in the code, strings of decimal digits such as `"1050"` (10.50 EUR) in the API, and whole yen for JPY. An entry's amount is signed: positive adds to the account's balance, negative subtracts. A deposit, withdrawal or transfer is at most `MAX_AMOUNT_MINOR` minor units (100000000000 by default).

Deposits and withdrawals move money against the settlement account of their currency, a system account with no cached balance: its balance is the sum of its entries and may go below zero. A customer balance never does. The ledger is append-only, in the code and in the database; a mistake is corrected by a reversal (`POST /v1/transactions/{id}/reversals`), never by an edit.

`npm run reconcile` checks every cached balance against the ledger and every currency's global sum against zero; see the [reconciliation runbook](docs/runbooks/reconciliation.md). Spec: [`specs/002-ledger`](specs/002-ledger/spec.md).

## Money movements

Operators deposit into any customer account (`POST /v1/accounts/{id}/deposits`); customers withdraw from their own accounts (`/withdrawals`) and transfer out of them (`/transfers`). Each answers 201 with `Location: /v1/transactions/{id}`; a withdrawal and a transfer also return the account's new balance. A movement in another currency than the account's answers 422 `/problems/currency-mismatch`, and a frozen or closed account 422 `/problems/account-not-active`.

**A transfer.** `POST /v1/accounts/{A1}/transfers` with `{"destinationAccountId": "<B1>", "amount": "1050", "currency": "EUR"}` writes one transaction of two entries, −1050 on A1 and +1050 on B1, and both balance changes, in one database transaction: all of it happens or none of it. A1 never goes below "0" (422 `/problems/insufficient-funds`). B1 must be an active customer account in the same currency. When B1 is another customer's, every reason it cannot be credited (unknown, a system account, frozen, closed, another currency, a balance that would pass the maximum) gets one answer, 422 `/problems/destination-unavailable`, so a transfer reveals nothing about other customers' accounts.

**Concurrent transfers.** Each movement locks the customer accounts it changes with `SELECT ... FOR UPDATE`, one by one in ascending id order, and checks balances and statuses only once it holds them; system accounts are never locked (ADR-0008). Crossed transfers (A1 to B1 while B1 sends to A1) and cycles (A1 to B1 to Z1 to A1) take their locks in the same order, so they queue instead of deadlocking. A deadlock or serialization failure that still happens is retried, up to 3 attempts with a short random backoff; an account lock not acquired within `ACCOUNT_LOCK_TIMEOUT_MS` (2000 ms) answers 503 `/problems/service-unavailable` with `Retry-After: 1`, and the request can be retried with the same `Idempotency-Key`. Spec: [`specs/003-money-movements`](specs/003-money-movements/spec.md).

## Corrections

The ledger is never edited. An operator corrects a movement by reversing it: `POST /v1/transactions/{id}/reversals` with a `reason` of 3 to 500 characters, which is stored and audited but never returned. The reversal is a new transaction, linked to the original, with every entry of the original negated, and the balances change with it.

A transaction is reversed at most once (409 `/problems/already-reversed`), even when two operators try at the same time, and a reversal cannot itself be reversed (422 `/problems/transaction-not-reversible`). A reversal that would take a customer balance below "0", because the money has moved on, answers 422 `/problems/insufficient-funds-for-reversal`. A reversal is allowed on a frozen account, so a mistake can be undone while the account is under review, and refused on a closed one (422 `/problems/account-not-active`). Spec: [`specs/004-reversals`](specs/004-reversals/spec.md).

## Duplicate requests

Every deposit, withdrawal, transfer and reversal requires an `Idempotency-Key` header, a fresh value such as a UUID for each new request; account creation takes one optionally. Keys belong to the user who sent them.

1. The first request with a key runs, and its response (status, headers and body) is stored with the key in the same database transaction as the movement.
2. A repeat with the same key, method, path and body, within `IDEMPOTENCY_KEY_TTL_SECONDS` (24 hours by default), gets the stored response byte for byte, with `Idempotent-Replayed: true`, and moves no money. This holds on any replica, because the key lives in PostgreSQL.
3. A repeat that arrives while the first is still running waits for it, at most `IDEMPOTENCY_WAIT_TIMEOUT_MS` (2000 ms), and then gets the stored response, or 409 `/problems/request-in-progress` with `Retry-After: 1` if the first is still running.
4. The same key with another method, path or body answers 422 `/problems/idempotency-key-reused`.

A client that gets a connection error, a 502, 503 or 504, or a 409 `/problems/request-in-progress` retries the same request with the same key, waiting `Retry-After` (200 ms without one), up to 60 times; it never retries any other 4xx. Expired keys are deleted by `npm run idempotency:cleanup`; see the [idempotency cleanup runbook](docs/runbooks/idempotency-cleanup.md). Spec: [`specs/005-idempotency`](specs/005-idempotency/spec.md).
