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

The stack's network is `10.210.0.0/24`, with nginx at the fixed address `10.210.0.10`, the only one the replicas trust for `X-Forwarded-For`, and the replicas at `10.210.0.11` and `10.210.0.12`. If another network of the host already uses that range, `docker compose up` fails with `invalid pool request: Pool overlaps with other one on this address space`. Then set `SCF_SUBNET_PREFIX` to three other octets, for example `SCF_SUBNET_PREFIX=10.212.0 docker compose up --build --wait` (and the same variable for every later command of that stack, or once in a `.env` file); it moves the subnet, the fixed addresses and the trusted address together.

With `make`, the same commands are `make up`, `make seed`, `make token` (or `make token SUB=<uuid> ROLE=operator`), `make reconcile`, `make logs` and `make down`; `make test` runs the whole suite in the tools image: `npm run check`, the integration tests against the stack's Postgres and Redis, and `npm run trace -- --require unit,integration`. `make e2e` and `make load` run the end-to-end suite and the load test (see below); unlike the other targets, they run on the host and need Node.

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

The end-to-end suite and the load test run against the Docker Compose stack through nginx, at `E2E_BASE_URL`: `http://localhost:8080` by default, and local only (`localhost`, `127.0.0.1` or `[::1]`, any port), since both read the stack's database on `127.0.0.1` too. `npm run test:e2e` (or `make e2e`) builds and starts its own stack under the Compose project `scf-e2e`, from empty volumes, on the network `10.211.0.0/24` (`E2E_SUBNET_PREFIX` moves it, as `SCF_SUBNET_PREFIX` does for your stack), and removes it at the end (`E2E_KEEP_STACK=1` keeps it running). It uses the same host ports, so stop your own stack first with `docker compose down` or `npm run infra:down`. `npm run load` (or `make load`) runs the load test of SYS-R20 against a running stack: 200 movements per second for 60 s over 1000 funded account pairs. It writes the result to [`docs/performance.md`](docs/performance.md).

Every behaviour is specified before it is built: the specs, with their requirements and acceptance criteria, are in [`specs/`](specs/README.md), and `npm run trace` fails when an acceptance criterion that must be proven has no passing test.

## API

Every endpoint is served under `/v1` and needs `Authorization: Bearer <JWT>` with the role `customer` or `operator` (`npm run token -- --sub <uuid> --role customer` prints one for local use). Swagger UI is at `/docs` and the OpenAPI document at `/docs/json`, without credentials; the same document is committed as [`docs/api/openapi.yaml`](docs/api/openapi.yaml), regenerated with `npm run openapi:export` and linted with `npm run openapi:lint`. The committed file is generated with the default settings, while `/docs/json` shows the running values of `MAX_AMOUNT_MINOR` and `IDEMPOTENCY_KEY_TTL_SECONDS`. Every error is `application/problem+json` (RFC 9457), and every response carries an `X-Request-Id`.

## Authentication

Every `/v1` request carries `Authorization: Bearer <JWT>`. The token is signed with HS256 and `JWT_SECRET`, and carries `sub` (the user's id, a UUID), `role` (`customer` or `operator`), `iat`, `exp` at most 15 minutes later, and the `iss` and `aud` of `JWT_ISSUER` and `JWT_AUDIENCE`. Each replica verifies it from the token and its configuration alone, so every replica accepts the same tokens. A missing, expired or otherwise invalid token answers 401 `/problems/unauthenticated`, and the answer never says which check failed. The authentication is simulated: the service issues no tokens, and a real identity provider would replace the shared secret (ADR-0012).

The role decides what a caller may do. Customers open, list and read their own accounts, read their history and transactions, withdraw and transfer. Operators deposit, read any customer account or transaction, freeze, unfreeze and close accounts, and reverse transactions. An operation the role does not have answers 403 `/problems/forbidden`. Another customer's account or transaction answers 404 `/problems/not-found`, exactly as an unknown id does. The full matrix is table 1.3 of [`specs/006-auth`](specs/006-auth/spec.md), and the e2e suite checks every cell on both replicas.

To mint a token for local use and demos, valid for 15 minutes and signed with the variables of the environment or `.env`:

```sh
npm run token -- --sub 0192f0a0-0000-7000-8000-00000000d0c1 --role customer
# against the Docker Compose stack, with its demo secret and only Docker on the host:
docker compose run --rm tools npm run --silent token -- --sub <uuid> --role operator
```

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

## Request pipeline

Every request is checked in one order, and the first failure answers (SYS-R31):

1. Route: an unknown path answers 404 `/problems/not-found`, with or without credentials, before any credential or body is read (SYS-R32).
2. Authentication (401), then the per-user rate limit (429), then the role (403): `onRequest` hooks of every `/v1` route, so they answer before the body is read. The role check never looks at ids, so a customer gets the same 403 whatever ids the request names.
3. Media type (415) and body size (413), from the content-type parser and the body limit; then a malformed request (400): a body that is not JSON, or a missing or malformed `Idempotency-Key` or cursor.
4. Idempotency: a key that matches a completed request gets its stored response here, before validation and every later check (SYS-R33); the same key with another body answers 422, and one still in progress 409.
5. Validation (422): the routes' Zod schemas attach their error to the request instead of answering it, and the runner answers it at this step, after the key step on routes that take a key ([ADR-0004](docs/adr/0004-typescript-with-fastify.md), [ADR-0009](docs/adr/0009-idempotency-inside-the-movements-transaction.md)).
6. Lookup (404), then the business rules (409, 422), inside the movement's database transaction: READ COMMITTED, customer accounts locked one by one in ascending id order, retried on a deadlock or serialization failure ([ADR-0008](docs/adr/0008-read-committed-with-ordered-pessimistic-row-locks.md)). An id in the path that is not a UUID answers 404 at the lookup (SYS-R42).

The answer of a keyed request, its exact bytes with the `requestId`, is stored with its key before the commit, and the handler sends exactly those bytes. The order and where each step lives are in section 5 of [plan 000](specs/000-overview/plan.md).

## Errors

Every error is `application/problem+json` (RFC 9457) with `type`, `title`, `status`, `detail` and `requestId`, and `errors` with one entry per field for a validation error (SYS-R24, [ADR-0016](docs/adr/0016-error-model.md)). `title` and `detail` are fixed per type, so two answers of one type differ only in `requestId`; one 404 body serves every unknown, foreign or system resource and every unknown route. No body holds a stack trace, SQL or an underlying error's message: a 500 is logged with its error and SQLSTATE, and its body says only that the service failed, with the `requestId` to report.

One function, `toProblem` in [`src/platform/http/error-handler.ts`](src/platform/http/error-handler.ts), turns a typed error into its status and type. The transient conditions answer 503 `/problems/service-unavailable` with `Retry-After: 1`, never 500: a lock or pool wait that ran out, retries exhausted, a statement or request timeout, a replica shutting down (SYS-R34). A rejection decided at the lookup step or by a business rule is stored for idempotent replay with its key; validation errors and 5xx are not, and commit nothing. Every type, its statuses and when it is answered are in section 4 of [spec 000](specs/000-overview/spec.md) and in the description of the OpenAPI document; the [timeouts runbook](docs/runbooks/timeouts-and-503.md) explains each 503.

## Test seams

Some tests need faults the production code never produces: a crash after a ledger write, a SQLSTATE on every attempt, a route that throws, a reversal check skipped, an extra member in a response body, a connection destroyed after the commit. `src/` holds only optional hook points for them, which the composition root ([`src/app.ts`](src/app.ts)) never sets; the seams themselves, and their one list, live in [`test/support/test-app.ts`](test/support/test-app.ts) (SYS-R37):

| Seam                              | What it does                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| `unit-of-work-faults`             | Throws after a named write step, rewrites one ledger entry's amount, or raises a SQLSTATE.   |
| `throwing-route`                  | Adds `GET /v1/test/throw`, which throws an error whose message no response may contain.      |
| `skip-existing-reversal-check`    | Skips a reversal's check for an existing reversal, so the unique constraint must answer 409. |
| `extra-response-member`           | Adds a member to every new response body from the key step on, never to a replay.            |
| `destroy-connection-after-commit` | Destroys the client's connection after the commit, before the answer is written.             |

The app records the seams it attached in `app.testSeams`, and SYS-AC24 checks that the production app has none.

## Configuration

Every setting is an environment variable, validated at startup before the service connects to anything or listens (SEC-R39). An invalid value stops it with exit code 1 and one error that names every invalid variable and its rule, never its value (SEC-R40). The variables, their rules and defaults are in section 1.2 of [`specs/007-security-ops`](specs/007-security-ops/spec.md); [`.env.example`](.env.example) lists them for local use, and `npm run env:sync` adds the missing ones to `.env`. Among the rules:

- The timeouts must fit inside each other: `REQUEST_TIMEOUT_MS` (25000 ms) above the worst case of the lock waits, the pool wait and the retries, and `SHUTDOWN_TIMEOUT_MS` (30000 ms) not below it (SEC-R35). See the [timeouts runbook](docs/runbooks/timeouts-and-503.md).
- `DB_POOL_MAX` (10) times the replicas, plus one readiness connection each and 10 spare, must fit in the database's connections (SEC-R36).
- The demo `JWT_SECRET` and `CURSOR_SECRET` of `compose.yaml` are refused when `NODE_ENV` is `production` (DEP-R07). In AWS every secret comes from Secrets Manager, and each database password arrives as `PGPASSWORD` beside a URL that holds none.
- Secrets, tokens, `Idempotency-Key` values and the passwords of the URLs are redacted from every log line (SEC-R22).

The load balancer reads its own: `RATE_LIMIT_IP_RPS` and `RATE_LIMIT_IP_BURST`. See the [rate limits runbook](docs/runbooks/rate-limits.md).

## Health checks

- `GET /health/live` answers 200 `{"status": "ok"}` while the process runs, checking nothing else (SEC-R23). The image's `HEALTHCHECK`, the ECS container health check and the ALB target group all use it, so a database outage never makes Docker or ECS replace every replica.
- `GET /health/ready` answers 200 `{"status": "ready"}` only when `SELECT 1` completes within 1000 ms on a connection kept apart from the request pool and every migration the code ships is applied; otherwise 503 `/problems/service-unavailable`, and a `warn` line names the failed check (SEC-R24). It answers 503 from the start of a shutdown (SEC-R26).

Both are outside `/v1` and need no token. On SIGTERM a replica drains for `SHUTDOWN_DRAIN_DELAY_MS`, stops accepting connections, finishes its requests within `SHUTDOWN_TIMEOUT_MS` and exits 0, or 1 if it had to cut work off; see the [shutdown runbook](docs/runbooks/shutdown.md).

## Metrics

Each replica serves Prometheus metrics at `/metrics` on `METRICS_PORT` (9464), a port the load balancer never routes to and no deployment publishes (SEC-R43). Locally: `docker compose exec api-1 wget -qO- http://127.0.0.1:9464/metrics`. Besides Node's process metrics, they count requests by route template and status (`scf_http_request_duration_seconds`), movements by kind and outcome (`scf_money_movements_total`), replays, lock timeouts, transaction retries, the pool's connections and acquire timeouts, and the per-user rate limit and its Redis errors: table 1.4 of [`specs/007-security-ops`](specs/007-security-ops/spec.md).

## AWS deployment

The target architecture is in [`docs/deployment/aws.md`](docs/deployment/aws.md), one section per Terraform module of [`infra/terraform/`](infra/terraform/): an ALB with AWS WAF in public subnets, the service on ECS Fargate with at least two tasks across two zones, RDS PostgreSQL 16 Multi-AZ behind RDS Proxy, ElastiCache Redis, Secrets Manager and CloudWatch alarms (spec 008, ADR-0014, ADR-0015). Migrations run as a one-off task before each deployment, and the idempotency cleanup runs every hour as a scheduled task.

Nothing in this repository applies the Terraform (DEP-R34). `npm run infra:validate` checks it with only Docker: `terraform fmt`, `terraform validate`, `tflint` and `checkov` with the policies of [`infra/policies/`](infra/policies/), each from an image pinned by digest. The document also gives the first deployment, the steps of every deployment, the failure modes and a cost estimate.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push, on pull requests to `main` and on demand:

- `ci`: `npm run check`, `npm run openapi:lint`, `npm run infra:validate`, the integration tests against Postgres and Redis, `npm run reconcile` on the test database they leave (LED-AC17), `npm run trace -- --require unit,integration` and `npm run build`. It uploads the unit and integration reports.
- `e2e`: `npm run test:e2e` on its own Compose project, `scf-e2e`; it uploads the e2e report and prints the stack's logs on failure.
- `traceability`: after `ci` and `e2e`, `npm run trace -- --require unit,integration,e2e` on the three reports, so every acceptance criterion that must be proven has a passing test at its level.
- `secret-scan`: gitleaks over the full git history.
- `security`: `npm audit --audit-level=high`, and trivy on the files, on the configuration and on the runtime image, from the `aquasec/trivy` image pinned by digest, failing on any HIGH or CRITICAL finding.

There is no deploy workflow: the pipeline that builds, pushes and deploys the image lives outside this repository, and [`docs/deployment/aws.md`](docs/deployment/aws.md#every-deployment) describes its steps.

## Runbooks

- [Deploy and migrate](docs/runbooks/deploy-and-migrate.md)
- [Rate limits](docs/runbooks/rate-limits.md)
- [Timeouts and 503](docs/runbooks/timeouts-and-503.md)
- [Shutdown](docs/runbooks/shutdown.md)
- [Reconciliation](docs/runbooks/reconciliation.md)
- [Idempotency cleanup](docs/runbooks/idempotency-cleanup.md)
