# 003 · Money movements · Plan

How deposits, withdrawals and transfers run, how their row locks are planned, and how a transaction is read. The shared conventions, the movement skeleton (section 6.2), the transaction runner and the error model are in [plan 000](../000-overview/plan.md); the ledger writes are in [plan 002](../002-ledger/plan.md); the key step is in plan 005. The spec wins over this plan.

## 1. Modules and files

| Path                                                                         | Phase     | Purpose                                                                                                                                                                                    |
| ---------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/modules/movements/domain/lock-plan.ts`                                  | 06-domain | `planLocks(accounts)`: the customer account ids, in canonical lowercase, without duplicates, ascending; system accounts and unknown ids left out (MOV-R18, MOV-R30). Plan 004 uses it too. |
| `src/modules/movements/domain/movement-rules.ts`                             | 06-domain | Steps 5 to 8 of section 1.4 as pure functions over the rows read under the locks (MOV-R12 to MOV-R17).                                                                                     |
| `src/modules/movements/domain/errors.ts`                                     | 06-domain | `CurrencyMismatch`, `InsufficientFunds`, `DestinationUnavailable`; `AccountNotActive` and `NotFound` come from the accounts module, `BalanceLimitExceeded` from the ledger module.         |
| `src/modules/movements/application/ports.ts`                                 | 06-domain | `MovementAccounts` (lookup without locks, lock one customer account), `TransactionQueries`, `AuditLog`, `IdGenerator`; the `LedgerWriter` of plan 002.                                     |
| `src/modules/movements/application/deposit.ts`, `withdraw.ts`, `transfer.ts` | 06-domain | One use case per movement, running steps 6 to 8 of the skeleton in the order of section 1.4 on the unit of work it is given.                                                               |
| `src/modules/movements/application/get-transaction.ts`                       | 06-domain | Query service for `GET /transactions/{id}` with the visibility of MOV-R26 to MOV-R28.                                                                                                      |
| `src/modules/movements/adapters/persistence/kysely-movements.ts`             | 06-domain | Kysely implementations of `MovementAccounts` and `TransactionQueries` with the statements of section 3.                                                                                    |
| `src/platform/config/config.ts`                                              | 08-api    | `ACCOUNT_LOCK_TIMEOUT_MS`, 1 to 4999, default 2000 (MOV-R31).                                                                                                                              |
| `src/modules/movements/adapters/http/schemas.ts`                             | 08-api    | Bodies `{amount, currency}` and `{destinationAccountId, amount, currency}`, strict, with the amount refinement of plan 002 and the destination rules of MOV-R10.                           |
| `src/modules/movements/adapters/http/presenters.ts`                          | 08-api    | The movement response of section 1.2 and the transaction representation of section 1.3.                                                                                                    |
| `src/modules/movements/adapters/http/routes.ts`                              | 08-api    | The four routes of section 1.1 under `/v1`, with their roles; movement routes call the idempotent runner of plan 005.                                                                      |
| `src/modules/movements/index.ts`                                             | 06-domain | The module's public API.                                                                                                                                                                   |

## 2. Data model changes

None of its own. Movements write the `transactions` and `ledger_entries` of plan 002, the cached balances of plan 001, the `audit_records` of plan 000 (`account_ids` holds the account of a deposit or withdrawal, or the source and destination of a transfer, ascending; MOV-R24) and the key rows of plan 005. The only setting is `ACCOUNT_LOCK_TIMEOUT_MS`.

## 3. Operations and their database statements

Each movement runs the skeleton of plan 000 section 6.2 with `retry: 'movement'`. Steps 1 to 5 (the key step and validation) are shared; validation covers `amount` (SYS-R07, LED-R24), `currency` (SYS-R09), and for a transfer `destinationAccountId`, which must be a UUID different from the path id once both are in canonical lowercase (MOV-R10, MOV-R30), and no unknown member in the body or the query string. The path id is parsed as a UUID at step 6; if it is not one, the lookup answers `NotFound` without a query (SYS-R42).

### 3.1 Deposit (`POST /accounts/{id}/deposits`, operator)

| Step | Statement or check                                                                                                                                                                                               | Failure (stored)                 |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 6    | `SELECT a.id, a.kind, a.currency, s.id AS settlement_id FROM accounts a JOIN accounts s ON s.kind = 'system' AND s.currency = a.currency WHERE a.id = $id`                                                       | no row or `kind = 'system'`: 404 |
| 6    | request currency against `a.currency`                                                                                                                                                                            | 422 `currency-mismatch`          |
| 7    | `SELECT app.set_lock_timeout($accountLockMs)`; `SELECT id, status, balance FROM accounts WHERE id = $id AND kind = 'customer' FOR UPDATE`                                                                        | 55P03: 503, not stored           |
| 7    | status `active`                                                                                                                                                                                                  | 422 `account-not-active`         |
| 7    | `credit(balance, amount)`                                                                                                                                                                                        | 422 `balance-limit-exceeded`     |
| 8    | `LedgerWriter.append(deposit)`: `INSERT INTO transactions`, `INSERT INTO ledger_entries` (+A on the account, −A on the settlement account), `UPDATE accounts SET balance = balance + A ...` (plan 002 section 4) |                                  |
| 8    | `INSERT INTO audit_records (..., action 'deposit', account_ids ARRAY[$id], transaction_id, request_id)`                                                                                                          |                                  |

### 3.2 Withdrawal (`POST /accounts/{id}/withdrawals`, owner)

| Step | Statement or check                                                                                                                                                     | Failure (stored)                                  |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 6    | `SELECT a.id, a.kind, a.owner_id, a.currency, s.id AS settlement_id FROM accounts a JOIN accounts s ON s.kind = 'system' AND s.currency = a.currency WHERE a.id = $id` | no row, system, or `owner_id` not the caller: 404 |
| 6    | request currency against `a.currency`                                                                                                                                  | 422 `currency-mismatch`                           |
| 7    | `SELECT app.set_lock_timeout($accountLockMs)`; `SELECT id, status, balance FROM accounts WHERE id = $id AND kind = 'customer' FOR UPDATE`                              | 55P03: 503, not stored                            |
| 7    | status `active`                                                                                                                                                        | 422 `account-not-active`                          |
| 7    | `amount <= balance`                                                                                                                                                    | 422 `insufficient-funds`                          |
| 8    | `LedgerWriter.append(withdrawal)` (−A on the account, +A on the settlement account); the `UPDATE ... RETURNING balance` gives the response's `balance`                 |                                                   |
| 8    | `INSERT INTO audit_records (..., action 'withdrawal', account_ids ARRAY[$id], ...)`                                                                                    |                                                   |

### 3.3 Transfer (`POST /accounts/{id}/transfers`, owner of the source)

| Step | Statement or check                                                                                                                                                                                             | Failure (stored)                                  |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 6    | `SELECT id, kind, owner_id, currency FROM accounts WHERE id IN ($source, $destination)`; these columns never change, so reading them without a lock is safe                                                    | source missing, system or not the caller's: 404   |
| 6    | request currency against the source's                                                                                                                                                                          | 422 `currency-mismatch`                           |
| 7    | `SELECT app.set_lock_timeout($accountLockMs)`; then for each id of `planLocks([source, destination row if found])`: `SELECT id, status, balance FROM accounts WHERE id = $id AND kind = 'customer' FOR UPDATE` | 55P03: 503, not stored                            |
| 7    | source status `active`                                                                                                                                                                                         | 422 `account-not-active`                          |
| 7    | `amount <= source balance`                                                                                                                                                                                     | 422 `insufficient-funds`                          |
| 7    | own destination (customer account of the caller): status `active`, then same currency                                                                                                                          | 422 `account-not-active`, 422 `currency-mismatch` |
| 7    | any destination: unknown, system, another customer's and not `active`, another customer's in another currency, or `credit(destination balance, amount)` above the limit                                        | 422 `destination-unavailable`, one fixed body     |
| 8    | `LedgerWriter.append(transfer)` (−A on the source, +A on the destination; two balance updates, ascending)                                                                                                      |                                                   |
| 8    | `INSERT INTO audit_records (..., action 'transfer', account_ids ARRAY[lower, higher], ...)`                                                                                                                    |                                                   |

A destination that is a system account is never locked: `planLocks` leaves it out, and the lock query selects only `kind = 'customer'` (MOV-R18, LED-AC09). The response carries only the source's `accountId` and `balance` (MOV-R25).

### 3.4 Locks, waits and retries

- The lock timeout is set immediately before the first account lock, after the key row and the lookups (MOV-R19). A 55P03 there is `AccountLockTimeout`: `ROLLBACK`, key row included, 503 with `Retry-After: 1`, not retried in process (MOV-R20); a retry with the same key is a first request (MOV-R21).
- Locks are taken one statement per account in ascending `uuid` order, so crossed and circular transfers wait instead of deadlocking (MOV-R23). A 40P01 or 40001 anyway re-runs the whole attempt (SYS-R18).
- Status and balance are read only by the `FOR UPDATE` statements, so every decision of section 1.4 steps 5 to 8 uses values no other movement can change before the commit (MOV-R22).

### 3.5 Read a transaction (`GET /transactions/{id}`)

The id is parsed as a UUID (404 if not). One statement:

```sql
SELECT t.id, t.kind, t.currency, t.created_at, t.reversed_transaction_id, e.account_id, e.amount, a.owner_id
FROM transactions t JOIN ledger_entries e ON e.transaction_id = t.id JOIN accounts a ON a.id = e.account_id
WHERE t.id = $id ORDER BY e.id
```

An operator gets every entry (MOV-R26); a customer gets only the entries whose `owner_id` is theirs, and 404 when there are none (MOV-R27, MOV-R28). The transaction's `amount` is the sum of its positive entries, which is A for every kind. `reversedTransactionId` is present only for a reversal (REV-R23).

## 4. Domain

- **`planLocks(accounts: {id, kind}[])`** lowercases every id, keeps `kind = 'customer'`, removes duplicates and sorts ascending. Canonical lowercase UUIDs sort in byte order as plain strings, which is PostgreSQL's `uuid` order; uppercase input is lowercased first, so "018F...B" never sorts before "018f...a" (MOV-AC15).
- **`movement-rules.ts`** takes the locked rows and returns the first failure of steps 5 to 8, or the ledger transaction to append. A transfer's destination is described by what the lookup and the lock found (`missing`, `system`, or a customer account with owner, currency, status and balance), so every condition of `destination-unavailable` is decided in one place, after the caller's own checks (MOV-R15, MOV-R17).

## 5. Error mapping

Shared errors are in section 7 of plan 000; the ledger's in plan 002. For a movement:

| Typed error              | When                                                                                               | Status | Type                                              | Stored for replay |
| ------------------------ | -------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------- | ----------------- |
| `MalformedRequest`       | `Idempotency-Key` missing or malformed (plan 005)                                                  | 400    | `/problems/malformed-request`                     | no                |
| `Forbidden`              | customer deposits; operator withdraws or transfers                                                 | 403    | `/problems/forbidden`                             | no                |
| `ValidationFailed`       | `amount`, `currency` or `destinationAccountId` invalid, above the maximum, or destination = source | 422    | `/problems/validation-error`                      | no                |
| `NotFound`               | path account unknown, not a UUID, system, or another customer's (withdrawal, transfer)             | 404    | `/problems/not-found`                             | yes               |
| `CurrencyMismatch`       | request currency differs from the path account's, or an own destination's from the source's        | 422    | `/problems/currency-mismatch`                     | yes               |
| `AccountNotActive`       | path account, or an own destination, `frozen` or `closed`                                          | 422    | `/problems/account-not-active`                    | yes               |
| `InsufficientFunds`      | amount above the debited account's balance                                                         | 422    | `/problems/insufficient-funds`                    | yes               |
| `DestinationUnavailable` | every condition of MOV-R15, one fixed `title` and `detail`                                         | 422    | `/problems/destination-unavailable`               | yes               |
| `BalanceLimitExceeded`   | a deposit would exceed the limit                                                                   | 422    | `/problems/balance-limit-exceeded`                | yes               |
| `AccountLockTimeout`     | 55P03 at an account lock                                                                           | 503    | `/problems/service-unavailable`, `Retry-After: 1` | no                |
| `IdempotencyWaitTimeout` | 55P03 at a key-wait step (3, 3b, 3c or a re-pass) (MOV-R29)                                        | 409    | `/problems/request-in-progress`, `Retry-After: 1` | no                |
| `ConfigError`            | `ACCOUNT_LOCK_TIMEOUT_MS` invalid at startup                                                       | none   | the app is not built                              | n/a               |

## 6. Acceptance criteria

| AC       | Level       | Phase        | Test file                                               |
| -------- | ----------- | ------------ | ------------------------------------------------------- |
| MOV-AC01 | integration | 08-api       | `test/integration/movements/movements.test.ts`          |
| MOV-AC02 | integration | 08-api       | `test/integration/movements/movements.test.ts`          |
| MOV-AC03 | integration | 08-api       | `test/integration/movements/movements.test.ts`          |
| MOV-AC04 | integration | 08-api       | `test/integration/movements/authorization.test.ts`      |
| MOV-AC05 | integration | 08-api       | `test/integration/movements/request-validation.test.ts` |
| MOV-AC06 | integration | 08-api       | `test/integration/movements/request-validation.test.ts` |
| MOV-AC07 | integration | 08-api       | `test/integration/movements/request-validation.test.ts` |
| MOV-AC08 | integration | 08-api       | `test/integration/movements/request-validation.test.ts` |
| MOV-AC09 | integration | 08-api       | `test/integration/movements/business-rules.test.ts`     |
| MOV-AC10 | integration | 08-api       | `test/integration/movements/business-rules.test.ts`     |
| MOV-AC11 | integration | 08-api       | `test/integration/movements/business-rules.test.ts`     |
| MOV-AC12 | integration | 08-api       | `test/integration/movements/lock-timeout.test.ts`       |
| MOV-AC13 | integration | 08-api       | `test/integration/movements/concurrency.test.ts`        |
| MOV-AC14 | integration | 09-hardening | `test/integration/movements/concurrency.test.ts`        |
| MOV-AC15 | unit        | 06-domain    | `test/unit/movements/lock-plan.test.ts`                 |
| MOV-AC16 | integration | 08-api       | `test/integration/movements/audit.test.ts`              |
| MOV-AC17 | integration | 08-api       | `test/integration/movements/atomicity.test.ts`          |
| MOV-AC18 | integration | 08-api       | `test/integration/movements/read-transaction.test.ts`   |
| MOV-AC19 | integration | 09-hardening | `test/integration/movements/lock-timeout.test.ts`       |
| MOV-AC20 | unit        | 08-api       | `test/unit/platform/config.test.ts`                     |

MOV-AC14 and MOV-AC19 start the service with `DB_POOL_ACQUIRE_TIMEOUT_MS`, `REQUEST_TIMEOUT_MS` and `SHUTDOWN_TIMEOUT_MS`, which the service first reads in 09-hardening (plan 000 section 1). MOV-AC19 also needs those values there, since with `ACCOUNT_LOCK_TIMEOUT_MS` "4000" the default request timeout would break the budget of SEC-R35. MOV-AC19 finds R1's and R2's backends through `pg_stat_activity` and `pg_blocking_pids` (plan 000 section 9), with no fixed delay.

## 7. ACs that cannot be tested as written

None found. Every AC of this spec can be proven as written at its level, in the phase listed above.
