# SuperCool Finances

Balance service for SuperCool Finances: customer accounts, a double-entry ledger and money movements.

[![CI](https://github.com/torsello/supercool-finances/actions/workflows/ci.yml/badge.svg)](https://github.com/torsello/supercool-finances/actions/workflows/ci.yml)

## Quick start

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
