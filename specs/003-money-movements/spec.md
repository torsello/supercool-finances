# 003 · Money movements

- **Status:** Draft
- **ID prefix:** MOV
- **Related ADRs:** none yet (phase 03-adrs)
- **Depends on specs:** 000-overview, 001-accounts, 002-ledger, 004-reversals, 005-idempotency

## 1. Context and goal

Money moves through three operations. A **deposit** simulates money arriving from a payment rail: an operator credits a customer account and the settlement account of that currency is debited. A **withdrawal** is the owner of an account taking money out: the customer account is debited and the settlement account credited. A **transfer** is the owner of a source account sending money to any active account in the same currency, their own or another customer's. This spec also defines how a transaction is read by id.

Each operation is one database transaction and requires an `Idempotency-Key`, whose behaviour is defined in spec 005. The ledger entries each operation writes, the settlement accounts, the maximum amount and the balance limits are defined in spec 002; the effect of an account's status is defined in spec 001. Terms have the meanings in the glossary of spec 000. Requirements marked with a question number, for example "(Q3)", follow the recommended answer of that open question until the owner decides; "(000 Q7)" refers to an open question of spec 000.

### 1.1 Operations

Paths are proposed here (Q1) and become final in the OpenAPI document (phase 08-api).

| Operation          | Method and path                   | Body                                             | Caller                                                |
| ------------------ | --------------------------------- | ------------------------------------------------ | ----------------------------------------------------- |
| Deposit            | `POST /accounts/{id}/deposits`    | `{"amount", "currency"}`                         | Operator                                              |
| Withdrawal         | `POST /accounts/{id}/withdrawals` | `{"amount", "currency"}`                         | Owner of the account                                  |
| Transfer           | `POST /accounts/{id}/transfers`   | `{"destinationAccountId", "amount", "currency"}` | Owner of the source `{id}`                            |
| Read a transaction | `GET /transactions/{id}`          | none                                             | Operator, or the owner of a customer account involved |

### 1.2 Movement response

A movement that is applied answers 201 with a `Location: /transactions/<id>` header and this body (Q2):

| Field       | Meaning                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `id`        | The transaction id, a UUIDv7 string.                                                                                             |
| `kind`      | `deposit`, `withdrawal` or `transfer`.                                                                                           |
| `amount`    | The amount moved, a string of decimal digits in minor units, without sign.                                                       |
| `currency`  | The currency of the movement.                                                                                                    |
| `createdAt` | When the transaction was recorded, RFC 3339 in UTC with milliseconds (001 Q13).                                                  |
| `accountId` | Withdrawal and transfer only: the caller's own account the money left, the source.                                               |
| `balance`   | Withdrawal and transfer only: the cached balance of `accountId` after the movement. Never the balance of any other account (Q3). |

### 1.3 Transaction representation

`GET /transactions/{id}` answers 200 with `id`, `kind`, `amount`, `currency`, `createdAt` as in 1.2, and `entries`: a list of `{"accountId", "amount"}` with signed amounts as strings. A transaction of kind `reversal` also carries `reversedTransactionId`, the id of the transaction it reverses (spec 004, REV-R23). An operator sees every entry of the transaction; a customer sees only the entries of their own accounts (Q9).

### 1.4 Order of checks

Within the order of SYS-R31, the checks of a movement run in this order and the first failure answers (Q6):

1. Validation of the request (422 `/problems/validation-error`): amount, currency, and for a transfer the destination id, including a destination equal to the source.
2. Lookup and ownership of the account in the path, including the check that its id is a UUID (404 `/problems/not-found`, SYS-R42).
3. Request currency against that account's currency (422 `/problems/currency-mismatch`).
4. Row locks on every customer account involved, in ascending id order (503 on lock timeout). The account lock timeout applies from this step on, after the idempotency record is written.
5. Status of the account in the path (422 `/problems/account-not-active`).
6. Funds of the account debited, for a withdrawal or transfer (422 `/problems/insufficient-funds`).
7. Transfer destination: if it is one of the caller's own accounts, its status (422 `/problems/account-not-active`) and currency (422 `/problems/currency-mismatch`); then, for any destination, the conditions of `/problems/destination-unavailable` (MOV-R15), all evaluated at this one step.
8. Balance limit of the account credited by a deposit (422 `/problems/balance-limit-exceeded`, spec 002).

Because every destination-unavailable condition is evaluated at the same step, after the caller's own checks, the answer for a destination never depends on which of those conditions holds.

## 2. Requirements

| ID      | Requirement (EARS)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MOV-R01 | WHEN an operator deposits an amount A in currency C into an `active` customer account in C THE SYSTEM SHALL record a deposit transaction with entries +A on the account and −A on the settlement account of C (LED-R09), raise the account's cached balance by A, and answer 201 with the response of section 1.2.                                                                                                                                                                                                   |
| MOV-R02 | WHEN the owner of an `active` customer account in currency C withdraws an amount A in C that is not greater than its balance THE SYSTEM SHALL record a withdrawal transaction with entries −A on the account and +A on the settlement account of C (LED-R09), lower the account's cached balance by A, and answer 201 with the response of section 1.2.                                                                                                                                                              |
| MOV-R03 | WHEN the owner of an `active` source account in currency C transfers an amount A in C, not greater than the source's balance, to a different `active` customer account in C, owned by them or by another customer, THE SYSTEM SHALL record a transfer transaction with entries −A on the source and +A on the destination (LED-R09), change both cached balances by those amounts, and answer 201 with the response of section 1.2.                                                                                  |
| MOV-R04 | IF a customer requests a deposit, or an operator requests a withdrawal or a transfer, THEN THE SYSTEM SHALL answer 403 with problem type `/problems/forbidden` and write nothing (SYS-R03, SYS-R04).                                                                                                                                                                                                                                                                                                                 |
| MOV-R05 | IF the account in the path of a withdrawal or transfer does not exist, belongs to another customer or is a system account, or the account in the path of a deposit does not exist or is a system account, THEN THE SYSTEM SHALL answer 404 with problem type `/problems/not-found`, with the body it gives for an unknown id, and write nothing (SYS-R05, SYS-R38).                                                                                                                                                  |
| MOV-R06 | THE SYSTEM SHALL apply each deposit, withdrawal and transfer in one database transaction whose first write is the idempotency record (spec 005), followed by the row locks, the transaction and its ledger entries, the cached balance changes and the audit record, so that all of them commit together or none does (SYS-R11).                                                                                                                                                                                     |
| MOV-R07 | IF a deposit, withdrawal or transfer request has no `Idempotency-Key` header, or a malformed one, THEN THE SYSTEM SHALL answer 400 with problem type `/problems/malformed-request` and write nothing (SYS-R26). The semantics of the key are defined in spec 005.                                                                                                                                                                                                                                                    |
| MOV-R08 | IF the `amount` of a movement request is missing, is not a JSON string of decimal digits without sign, leading zero, separator or exponent, is "0", or is greater than the configured maximum, THEN THE SYSTEM SHALL answer 422 with problem type `/problems/validation-error` and one `errors` entry for `amount`, and write nothing (SYS-R07, LED-R24).                                                                                                                                                            |
| MOV-R09 | IF the `currency` of a movement request is missing or not a code of table 1.3 of spec 000 THEN THE SYSTEM SHALL answer 422 with problem type `/problems/validation-error` and one `errors` entry for `currency`, and write nothing (SYS-R09).                                                                                                                                                                                                                                                                        |
| MOV-R10 | IF the `destinationAccountId` of a transfer is missing or not a UUID, or equals the source account id in the path once both are parsed as UUIDs and compared in canonical lowercase form (MOV-R30), THEN THE SYSTEM SHALL answer 422 with problem type `/problems/validation-error` and one `errors` entry for `destinationAccountId`, and write nothing (Q4).                                                                                                                                                       |
| MOV-R11 | IF the currency of a movement request differs from the currency of the account in the path THEN THE SYSTEM SHALL answer 422 with problem type `/problems/currency-mismatch` and write nothing (Q5).                                                                                                                                                                                                                                                                                                                  |
| MOV-R12 | IF the account in the path of a deposit, withdrawal or transfer is `frozen` or `closed` THEN THE SYSTEM SHALL answer 422 with problem type `/problems/account-not-active` and write nothing (ACC-R19).                                                                                                                                                                                                                                                                                                               |
| MOV-R13 | IF the destination of a transfer is one of the caller's own accounts and is `frozen` or `closed` THEN THE SYSTEM SHALL answer 422 with problem type `/problems/account-not-active` and write nothing (ACC-R19).                                                                                                                                                                                                                                                                                                      |
| MOV-R14 | IF the destination of a transfer is one of the caller's own accounts and its currency differs from the source's THEN THE SYSTEM SHALL answer 422 with problem type `/problems/currency-mismatch` and write nothing (Q5).                                                                                                                                                                                                                                                                                             |
| MOV-R15 | IF the destination of a transfer does not exist, is a system account, belongs to another customer and is `frozen` or `closed`, belongs to another customer and has a currency different from the source's (Q5), or would have its cached balance exceed 9223372036854775807 whoever owns it (LED-R29), THEN THE SYSTEM SHALL answer 422 with problem type `/problems/destination-unavailable`, with the same `title`, `detail` and every other member except `requestId` in every case, and write nothing (SYS-R41). |
| MOV-R16 | IF a withdrawal or transfer amount is greater than the cached balance of the account debited, read while its row lock is held, THEN THE SYSTEM SHALL answer 422 with problem type `/problems/insufficient-funds`, write no transaction, ledger entry, balance change or audit record, and leave every balance unchanged (SYS-R12).                                                                                                                                                                                   |
| MOV-R17 | THE SYSTEM SHALL run the checks of a movement in the order of section 1.4 and answer the first that fails (Q6).                                                                                                                                                                                                                                                                                                                                                                                                      |
| MOV-R18 | THE SYSTEM SHALL lock every customer account a movement involves with `SELECT ... FOR UPDATE`, one by one in ascending id order, which is PostgreSQL's order of the `uuid` type, never lock a system account's row (LED-R14), and read the status and balance used by the checks only after all those locks are held.                                                                                                                                                                                                |
| MOV-R19 | THE SYSTEM SHALL bound the wait for each account row lock by the account lock timeout, read from the configuration variable `ACCOUNT_LOCK_TIMEOUT_MS`, and apply it through the lock-timeout function of SEC-R31 only after the idempotency record is written, immediately before the first account lock, so that the insert of the idempotency record waits under the idempotency wait timeout of spec 005 instead (Q7).                                                                                            |
| MOV-R20 | IF a customer account's row lock is not acquired within the account lock timeout THEN THE SYSTEM SHALL roll back the movement's database transaction, so that no transaction, ledger entry, balance change, idempotency record or audit record remains, and answer 503 with problem type `/problems/service-unavailable` and the header `Retry-After: 1`, without retrying in process (Q7).                                                                                                                          |
| MOV-R21 | WHEN a request is retried with the same `Idempotency-Key` after a 503 for a lock timeout THE SYSTEM SHALL process it as a first request, applying the movement at most once (spec 005).                                                                                                                                                                                                                                                                                                                              |
| MOV-R22 | WHEN money movements on the same accounts run concurrently THE SYSTEM SHALL accept only movements whose debits the balance covers at the moment their locks are held, so that the amounts accepted from an account never exceed what it held and its balance is never below zero (SYS-R12, SYS-R17).                                                                                                                                                                                                                 |
| MOV-R23 | WHEN transfers between the same accounts run concurrently in opposite directions THE SYSTEM SHALL complete them without a deadlock error, a 500 or a 503 reaching the client, relying on the lock order of MOV-R18 and the retry of SYS-R18.                                                                                                                                                                                                                                                                         |
| MOV-R24 | WHEN a deposit, withdrawal or transfer commits THE SYSTEM SHALL write, in the same database transaction, one audit record with the acting user, their role, the action (the movement's kind), the customer accounts involved, the transaction id, the correlation id and the time (SYS-R23, Q11). A rejected movement writes no audit record.                                                                                                                                                                        |
| MOV-R25 | THE SYSTEM SHALL return in a movement response only the fields of section 1.2, and the balance only of the caller's own source account of a withdrawal or transfer; a deposit response carries no balance (Q3).                                                                                                                                                                                                                                                                                                      |
| MOV-R26 | WHEN an operator reads a transaction by id THE SYSTEM SHALL answer 200 with the representation of section 1.3, including `reversedTransactionId` when the transaction is a reversal, and every entry of the transaction (Q9).                                                                                                                                                                                                                                                                                        |
| MOV-R27 | WHEN a customer reads a transaction by id that involves one of their own customer accounts THE SYSTEM SHALL answer 200 with the representation of section 1.3, including `reversedTransactionId` when the transaction is a reversal, and only the entries of their own accounts (Q9).                                                                                                                                                                                                                                |
| MOV-R28 | IF a customer reads a transaction that does not exist, that involves none of their accounts, or whose id is not a UUID, THEN THE SYSTEM SHALL answer 404 with problem type `/problems/not-found`, with bodies that differ only in `requestId` (Q9).                                                                                                                                                                                                                                                                  |
| MOV-R29 | IF the insert of a movement's idempotency record does not complete within the idempotency wait timeout of spec 005, including when it fails with SQLSTATE 55P03, THEN THE SYSTEM SHALL answer 409 with the problem type spec 005 defines for a key whose first request is still in progress, and never 503.                                                                                                                                                                                                          |
| MOV-R30 | THE SYSTEM SHALL parse every account id of a movement request, in the path and in the body, as a UUID in upper or lower case, and use only its canonical lowercase form to compare, look up and order account ids. A path id that is not a UUID answers 404 (SYS-R42); a `destinationAccountId` that is not one answers 422 (MOV-R10).                                                                                                                                                                               |
| MOV-R31 | THE SYSTEM SHALL read `ACCOUNT_LOCK_TIMEOUT_MS` as a string of decimal digits without sign or leading zero from 1 to 4999, below the runtime role's `statement_timeout` of 5 seconds (SEC-R29), so that an account lock wait always ends as SQLSTATE 55P03 and never as 57014, with 2000 when it is unset; IF it is set to any other value THEN THE SYSTEM SHALL refuse to start, with an error that names the variable (Q7).                                                                                        |

## 3. Acceptance criteria

Unless stated otherwise: customer user C1 owns account A1 (EUR) and A2 (EUR), customer user C2 owns account B1 (EUR), customer user C3 owns account Z1 (EUR), operator user O1 is an operator, balances are set up by deposits from O1, every POST carries a fresh Idempotency-Key, S is the EUR settlement account, U is an account id that does not exist, and `MAX_AMOUNT_MINOR` is unset.

### MOV-AC01 · Deposit

- **Level:** integration
- **Covers:** MOV-R01, MOV-R25
- **Given** A1 with "0" EUR
- **When** O1 deposits `{"amount": "5000", "currency": "EUR"}` into A1
- **Then** the answer is 201 with `Location: /transactions/<id>` and a body with exactly `id` <id>, `kind` "deposit", `amount` "5000", `currency` "EUR" and `createdAt`, and no `balance`; A1 is "5000" EUR; and transaction <id> has exactly the entries "5000" on A1 and "-5000" on S

### MOV-AC02 · Withdrawal

- **Level:** integration
- **Covers:** MOV-R02, MOV-R25
- **Given** A1 with "5000" EUR
- **When** C1 withdraws `{"amount": "1200", "currency": "EUR"}` from A1, and then withdraws `{"amount": "3800", "currency": "EUR"}` from A1
- **Then** the first answers 201 with `Location: /transactions/<id>` and a body with exactly `id` <id>, `kind` "withdrawal", `amount` "1200", `currency` "EUR", `createdAt`, `accountId` A1 and `balance` "3800"; transaction <id> has exactly the entries "-1200" on A1 and "1200" on S; the second, which takes the whole balance, answers 201 with `balance` "0"; and A1 is "0" EUR

### MOV-AC03 · Transfer to another customer and to an own account

- **Level:** integration
- **Covers:** MOV-R03, MOV-R25
- **Given** A1 with "5000" EUR, A2 with "0" EUR and B1 with "100" EUR
- **When** C1 transfers `{"destinationAccountId": B1, "amount": "300", "currency": "EUR"}` from A1, and then `{"destinationAccountId": A2, "amount": "700", "currency": "EUR"}` from A1
- **Then** the first answers 201 with a body with exactly `id`, `kind` "transfer", `amount` "300", `currency` "EUR", `createdAt`, `accountId` A1 and `balance` "4700", with no member holding B1's id or balance; its transaction has exactly the entries "-300" on A1 and "300" on B1 and none on a system account; the second answers 201 with `accountId` A1 and `balance` "4000" and no member holding A2's balance; and the balances are A1 "4000", A2 "700" and B1 "400" EUR

### MOV-AC04 · Each role moves money only as permitted

- **Level:** integration
- **Covers:** MOV-R04, MOV-R05
- **Given** A1 with "1000" EUR and B1 with "1000" EUR
- **When** C1 deposits "100" EUR into A1; O1 withdraws "100" EUR from A1; O1 transfers "100" EUR from A1 to B1; C2 withdraws "100" EUR from A1; C2 transfers "100" EUR from A1 to B1; C1 withdraws "100" EUR from S and from U; and O1 deposits "100" EUR into S and into U
- **Then** C1's deposit and O1's withdrawal and transfer answer 403 with type `/problems/forbidden`; C2's two requests and C1's two withdrawals answer 404 with type `/problems/not-found`; O1's two deposits answer 404 with a body equal, except for `requestId`, to the one for U; and A1 and B1 stay "1000" EUR with no transaction added

### MOV-AC05 · Missing Idempotency-Key

- **Level:** integration
- **Covers:** MOV-R07
- **Given** A1 with "1000" EUR and B1 with "0" EUR
- **When** O1 deposits "100" EUR into A1, C1 withdraws "100" EUR from A1 and C1 transfers "100" EUR from A1 to B1, each without an `Idempotency-Key` header, and each again with an empty one
- **Then** all six answer 400 with type `/problems/malformed-request`, and A1 stays "1000" EUR and B1 "0" EUR

### MOV-AC06 · Amount validation

- **Level:** integration
- **Covers:** MOV-R08
- **Given** A1 with "1000" EUR and B1 with "0" EUR
- **When** O1 deposits into A1, C1 withdraws from A1, and C1 transfers from A1 to B1, each with `currency` "EUR" and `amount` "0", then "-100", then "abc", then "10.50", then "0100", then "100000000001", then the JSON number 100, and then with no `amount` member
- **Then** each of the 24 requests answers 422 with type `/problems/validation-error` and exactly one `errors` entry, whose pointer is `/amount`; and A1 stays "1000" EUR and B1 "0" EUR with no transaction added

### MOV-AC07 · Currency validation and mismatch

- **Level:** integration
- **Covers:** MOV-R09, MOV-R11, MOV-R14
- **Given** A1 with "1000" EUR, C1's own J1 with "0" JPY, and B1 with "0" EUR
- **When** C1 withdraws `{"amount": "100"}` with no currency from A1, and `{"amount": "100", "currency": "GBP"}`; O1 deposits "100" USD into A1; C1 withdraws "100" USD from A1; C1 transfers "100" USD from A1 to B1; and C1 transfers "100" EUR from A1 to J1
- **Then** the first two answer 422 with type `/problems/validation-error` and one `errors` entry, for `currency`; the other four answer 422 with type `/problems/currency-mismatch`; and A1 stays "1000" EUR, J1 "0" JPY and B1 "0" EUR

### MOV-AC08 · Transfer destination id validation and same account

- **Level:** integration
- **Covers:** MOV-R10, MOV-R30
- **Given** A1 with "1000" EUR
- **When** C1 transfers "100" EUR from A1 with `destinationAccountId` A1, with A1's id in uppercase, with "not-a-uuid", with the JSON number 7, and with no `destinationAccountId`
- **Then** each answers 422 with type `/problems/validation-error` and exactly one `errors` entry, for `destinationAccountId`; and A1 stays "1000" EUR with no transaction added

### MOV-AC09 · A frozen or closed account cannot move money

- **Level:** integration
- **Covers:** MOV-R12, MOV-R13
- **Given** C1 owns F1, `frozen` with "5000" EUR, X1, `closed` with "0" EUR, and A1, `active` with "1000" EUR
- **When** O1 deposits "100" EUR into F1 and into X1; C1 withdraws "100" EUR from F1 and from X1; C1 transfers "100" EUR from F1 to A1 and from X1 to A1; and C1 transfers "100" EUR from A1 to F1 and from A1 to X1
- **Then** all eight answer 422 with type `/problems/account-not-active`; F1 stays "5000" EUR, X1 "0" EUR and A1 "1000" EUR; and no transaction is added

### MOV-AC10 · Every unavailable destination gets the same answer

- **Level:** integration
- **Covers:** MOV-R15, MOV-R17
- **Given** the service started with `MAX_AMOUNT_MINOR` "9223372036854775807"; C1 owns A1 with "10000" EUR, P1 with "50" EUR, and M1 with "9223372036854775807" EUR; C2 owns F2, `frozen` with "0" EUR, X2, `closed` with "0" EUR, D2, `active` with "0" USD, and M2, `active` with "9223372036854775807" EUR
- **When** C1 transfers "100" EUR from A1 to U, S, F2, X2, D2, M2 and M1; and then transfers "100" EUR from P1 to the same seven destinations
- **Then** the first seven answer 422 with type `/problems/destination-unavailable` and bodies that are equal except for `requestId`; the next seven answer 422 with type `/problems/insufficient-funds` and bodies that are equal except for `requestId`; and no balance changes and no transaction is added

### MOV-AC11 · Insufficient funds

- **Level:** integration
- **Covers:** MOV-R16
- **Given** A1 with "1000" EUR and B1 with "0" EUR
- **When** C1 withdraws "1001" EUR from A1 with `X-Request-Id: req-if1`, and transfers "1001" EUR from A1 to B1 with `X-Request-Id: req-if2`
- **Then** both answer 422 with type `/problems/insufficient-funds`; A1 stays "1000" EUR and B1 "0" EUR; and no transaction, ledger entry or audit record exists for either request

### MOV-AC12 · An account lock that is not acquired in time

- **Level:** integration
- **Covers:** MOV-R19, MOV-R20, MOV-R21
- **Given** the service started with `ACCOUNT_LOCK_TIMEOUT_MS` "200"; A1 with "1000" EUR and B1 with "0" EUR; and a separate database session that holds `SELECT ... FOR UPDATE` on A1's row
- **When** C1 withdraws "100" EUR from A1 with Idempotency-Key k1, and C2 transfers "100" EUR from B1 to A1 with Idempotency-Key k2 after O1 deposits "500" EUR into B1; then the session releases its lock; then C1 repeats the withdrawal with k1
- **Then** the withdrawal and the transfer each answer 503 with type `/problems/service-unavailable` and `Retry-After: 1`, after at least 200 ms and in less than 5 seconds; no transaction, ledger entry, idempotency record or audit record exists for k1 or k2; the repeated withdrawal answers 201 with `balance` "900"; and exactly one withdrawal transaction exists for k1

### MOV-AC13 · Concurrent withdrawals never overdraw

- **Level:** integration
- **Covers:** MOV-R22
- **Given** A1 with "10000" EUR
- **When** C1 sends 100 withdrawals of "300" EUR from A1 at the same time, each with its own Idempotency-Key
- **Then** exactly 33 answer 201 and 67 answer 422 with type `/problems/insufficient-funds`; the accepted withdrawals sum to "9900" EUR; no response is a 5xx; A1 is "100" EUR; 33 withdrawal transactions exist; and the reconciliation of spec 002 reports no discrepancy

### MOV-AC14 · Crossed and circular transfers never deadlock

- **Level:** integration
- **Covers:** MOV-R23
- **Given** the service started with `DB_POOL_ACQUIRE_TIMEOUT_MS` "10000", `REQUEST_TIMEOUT_MS` "30000" and `SHUTDOWN_TIMEOUT_MS` "30000", so the whole burst can queue for a connection (SEC-R38); A1 owned by C1, B1 owned by C2 and Z1 owned by C3, each with "200000" EUR, more than any of them sends in total, so that no transfer can run out of funds whatever the order
- **When** at the same time, C1 sends 100 transfers of "1000" EUR from A1 to B1, C2 sends 100 from B1 to A1, and C1 sends 50 transfers of "500" EUR from A1 to B1, C2 sends 50 from B1 to Z1 and C3 sends 50 from Z1 to A1, closing a cycle
- **Then** all 350 answer 201 and no response is a 5xx; the balances are A1, B1 and Z1 "200000" EUR each; and the reconciliation of spec 002 reports no discrepancy

### MOV-AC15 · Locks are planned in ascending id order, without system accounts

- **Level:** unit
- **Covers:** MOV-R18, MOV-R30
- **Given** customer account ids a = "018f2a00-0000-7000-8000-00000000000a" and b = "018f2a00-0000-7000-8000-00000000000b", b also written in uppercase as "018F2A00-0000-7000-8000-00000000000B", and the settlement account S
- **When** the lock plan is computed for a transfer from b in uppercase to a, a transfer from a to b, a deposit into b in uppercase and a withdrawal from a
- **Then** both transfers lock a then b, in canonical lowercase form, although "018F...B" sorts before "018f...a" as a plain string; the deposit locks only b, in lowercase; the withdrawal locks only a; and no plan contains S

### MOV-AC16 · Each movement writes one audit record in its transaction

- **Level:** integration
- **Covers:** MOV-R24
- **Given** A1 with "0" EUR and B1 with "0" EUR
- **When** O1 deposits "1000" EUR into A1 with `X-Request-Id: req-d`, C1 withdraws "100" EUR from A1 with `X-Request-Id: req-w`, C1 transfers "200" EUR from A1 to B1 with `X-Request-Id: req-t`, and C1 withdraws "999999" EUR from A1
- **Then** exactly three audit records exist for these requests: actor O1, role operator, action deposit, account A1, correlation id "req-d"; actor C1, role customer, action withdrawal, account A1, correlation id "req-w"; actor C1, role customer, action transfer, accounts A1 and B1, correlation id "req-t"; each holds the transaction id of its response and a time; and the rejected withdrawal has none

### MOV-AC17 · A movement is all or nothing

- **Level:** integration
- **Covers:** MOV-R06
- **Given** the test app (SYS-R37) with a fault injected after the ledger entries and balance changes of a transfer are written and before its audit record; A1 with "1000" EUR and B1 with "0" EUR
- **When** C1 transfers "300" EUR from A1 to B1 with Idempotency-Key k1, and then repeats it with k1 after the fault is removed
- **Then** the first answers 500 with type `/problems/internal-error`, and afterwards no transaction, ledger entry, idempotency record or audit record exists for k1 and A1 is "1000" EUR, B1 "0" EUR; the repeat answers 201; and A1 is "700" EUR, B1 "300" EUR with exactly one transaction for k1

### MOV-AC18 · Reading a transaction

- **Level:** integration
- **Covers:** MOV-R26, MOV-R27, MOV-R28
- **Given** O1 deposited "1000" EUR into A1 as transaction D, and C1 transferred "300" EUR from A1 to B1 as transaction T
- **When** O1 reads T; C1 reads T; C2 reads T; C2 reads D; C3 reads T; C1 reads U as a transaction id; and C1 reads "not-a-uuid"
- **Then** O1 gets 200 with `kind` "transfer", `amount` "300", `currency` "EUR" and the entries "-300" on A1 and "300" on B1; C1 gets 200 with only the entry "-300" on A1; C2 gets 200 with only the entry "300" on B1, and no member holding A1's id; C2's read of D, C3's read of T, and C1's reads of U and "not-a-uuid" answer 404 with type `/problems/not-found` and bodies that differ only in `requestId`

### MOV-AC19 · The idempotency wait and the account lock timeout are separate

- **Level:** integration
- **Covers:** MOV-R19, MOV-R29
- **Given** the service started with `ACCOUNT_LOCK_TIMEOUT_MS` "4000", `IDEMPOTENCY_WAIT_TIMEOUT_MS` "300", `REQUEST_TIMEOUT_MS` "30000" and `SHUTDOWN_TIMEOUT_MS` "30000"; A1 with "1000" EUR; and a separate database session that holds `SELECT ... FOR UPDATE` on A1's row
- **When** C1 withdraws "100" EUR from A1 with Idempotency-Key k1 (request R1); once R1's database session is observed waiting on A1's row lock (in `pg_stat_activity` with `wait_event_type` "Lock", blocked by the session that holds the lock, as `pg_blocking_pids` shows), C1 sends the same request with k1 again (request R2), with no fixed delay
- **Then** R2's database session is observed blocked by R1's session, not by the session that holds A1's lock; R2 answers 409 with the problem type spec 005 defines for a key whose first request is still in progress, while R1 has not answered yet; after that, R1 answers 503 with type `/problems/service-unavailable` and `Retry-After: 1`; and A1 stays "1000" EUR, with no transaction, ledger entry, idempotency record or audit record for k1

### MOV-AC20 · The account lock timeout is validated at startup

- **Level:** unit
- **Covers:** MOV-R31
- **Given** the configuration loader and an otherwise valid environment
- **When** it loads `ACCOUNT_LOCK_TIMEOUT_MS` unset, "1" and "4999"; and then "0", "5000", "-1", "+5", "0500", "1e3", "10.5", "abc", "", " 500" and "2000ms"
- **Then** the first three give 2000, 1 and 4999 milliseconds; each of the others fails with a configuration error whose message names `ACCOUNT_LOCK_TIMEOUT_MS`, and the app is not built

## 4. Error catalogue

Errors shared by every capability are in spec 000, and the maximum amount and balance limit in spec 002. For a movement:

| Condition                                                                                                                                                                    | HTTP | Problem type                      | Stored for idempotent replay |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | --------------------------------- | ---------------------------- |
| No `Idempotency-Key`, or a malformed one                                                                                                                                     | 400  | /problems/malformed-request       | no                           |
| A customer deposits, or an operator withdraws or transfers                                                                                                                   | 403  | /problems/forbidden               | no                           |
| `amount`, `currency` or `destinationAccountId` missing or malformed, `amount` above the maximum, or the destination equal to the source                                      | 422  | /problems/validation-error        | no                           |
| The account in the path is unknown, not a UUID, a system account, or another customer's (withdrawal and transfer)                                                            | 404  | /problems/not-found               | yes                          |
| The request currency differs from the account's, or an own destination's currency differs from the source's                                                                  | 422  | /problems/currency-mismatch       | yes                          |
| The account in the path, or an own destination, is `frozen` or `closed`                                                                                                      | 422  | /problems/account-not-active      | yes                          |
| The amount is greater than the balance of the account debited                                                                                                                | 422  | /problems/insufficient-funds      | yes                          |
| The destination is unknown, a system account, another customer's `frozen`, `closed` or other-currency account, or would exceed the balance limit                             | 422  | /problems/destination-unavailable | yes                          |
| A deposit would make the balance exceed 9223372036854775807 (LED-R26)                                                                                                        | 422  | /problems/balance-limit-exceeded  | yes                          |
| An account row lock is not acquired within `ACCOUNT_LOCK_TIMEOUT_MS`, answered with `Retry-After: 1`                                                                         | 503  | /problems/service-unavailable     | no                           |
| The same `Idempotency-Key` is still in progress after the idempotency wait timeout of spec 005, including SQLSTATE 55P03 at the key's insert, answered with `Retry-After: 1` | 409  | /problems/request-in-progress     | no                           |
| `ACCOUNT_LOCK_TIMEOUT_MS` is not a decimal integer from 1 to 4999                                                                                                            | n/a  | none: the service does not start  | n/a                          |
| A transaction that does not exist, is not visible to the customer, or has an id that is not a UUID                                                                           | 404  | /problems/not-found               | n/a: reads take no key       |

## 5. Invariants

- Every applied movement is exactly one transaction of the shape in table 1.1 of spec 002, with one audit record (MOV-AC01, MOV-AC02, MOV-AC03, MOV-AC16).
- A rejected movement leaves no transaction, ledger entry, balance change or audit record (MOV-AC06 to MOV-AC12).
- No customer account balance goes below zero under any concurrency (MOV-AC13).
- No movement updates or locks a system account's row (LED-R14), and customer accounts are locked in ascending id order (MOV-AC15).
- A movement response never carries the balance or id of another customer's account, and the answer for an unavailable destination never depends on which condition made it unavailable (MOV-AC03, MOV-AC10).
- The invariants of specs 000, 001 and 002 hold before and after every operation of this spec.

## 6. Out of scope

- Reversals: they are an operator action with their own rules, defined in spec 004 (Q10).
- The semantics of the `Idempotency-Key`: spec 005.
- Exchange between currencies (FX), fees, scheduled or recurring transfers, and limits per day or per customer.
- Real payment rails: a deposit is entered by an operator, and a withdrawal only records money leaving through the settlement account.
- Timing and contention side channels: a destination that exists may answer more slowly, or with 503 under lock contention, than one that does not (Q8).
- Listing transactions; an account's history is read through spec 001.

## 7. Open questions

| #   | Question                                                                                   | Recommended answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Decided by        |
| --- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Q1  | What are the paths of the movements?                                                       | Decided: `POST /accounts/{id}/deposits`, `/withdrawals` and `/transfers`, with the account the caller acts on in the path, so that SYS-R31's lookup step always has one account to check, and `GET /transactions/{id}`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | owner, 2026-10-07 |
| Q2  | What does a movement answer, and with which field names?                                   | Decided: 201 with `Location: /transactions/<id>`, like account creation (ACC-R01). Field names follow the API's camelCase (`createdAt`, as in spec 001) and the kind of movement is `kind`, as in the history entry of spec 001 and the ledger of spec 002, so that one name means one thing across the API.                                                                                                                                                                                                                                                                                                                                                                                                                        | owner, 2026-10-07 |
| Q3  | Which balance does a movement response carry?                                              | Decided: Only the caller's own account the money left: the source of a withdrawal or transfer, even when the destination is also the caller's. A deposit response carries no balance, because the operator owns no account; the operator can read the account (ACC-R10).                                                                                                                                                                                                                                                                                                                                                                                                                                                            | owner, 2026-10-07 |
| Q4  | Which answer does a transfer to the same account, or with a malformed destination id, get? | Decided: 422 `/problems/validation-error` with an `errors` entry for `destinationAccountId`. Both are visible from the request alone, so they are checked with the request schema, before any lookup, and reveal nothing about other accounts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | owner, 2026-10-07 |
| Q5  | Which answer does a currency mismatch get?                                                 | Decided: `/problems/currency-mismatch` when the request's currency differs from the account in the path, or when an own destination has another currency. When another customer's destination has another currency, `/problems/destination-unavailable`: a distinct answer would tell the sender that the account exists and its currency. SYS-R41 lists this case.                                                                                                                                                                                                                                                                                                                                                                 | owner, 2026-10-07 |
| Q6  | In which order are the business rules checked?                                             | Decided: The order of section 1.4: the caller's own account first (currency, status, funds), then every destination condition at one step. A sender with too little money therefore gets `insufficient-funds` whatever the destination, and a sender with enough gets the same `destination-unavailable` for every unavailable destination.                                                                                                                                                                                                                                                                                                                                                                                         | owner, 2026-10-07 |
| Q7  | How is the account lock timeout configured, and how does it answer?                        | Decided: `ACCOUNT_LOCK_TIMEOUT_MS`, default 2000, from 1 to 4999 (MOV-R31); its final value, shorter than the request timeout, is fixed in spec 007 (SYS-R35). It is applied through the lock-timeout function of SEC-R31 only after the idempotency record is written, immediately before the first account lock, so that a second request with the same key waits under the idempotency wait timeout of spec 005 and answers 409, never 503 (MOV-R29). A lock timeout (SQLSTATE 55P03) on an account is not retried in process, because the request has already waited the whole timeout; it answers 503 with `Retry-After: 1`, and the rollback removes the idempotency record, so a retry with the same key is a first request. | owner, 2026-10-07 |
| Q8  | Does a 503 for a lock on another customer's destination reveal that it exists?             | Decided: Yes, under sustained contention on that account only. Accepted: answering `destination-unavailable` instead would refuse a valid transfer, and the same information leaks through timing anyway.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | owner, 2026-10-07 |
| Q9  | What does reading a transaction show?                                                      | Decided: The fields of section 1.3. An operator sees every entry, system accounts included. A customer sees only the entries of their own accounts, so the receiver of a transfer never learns the sender's account id (as in 001 Q9). A transaction that is unknown, not visible, or has an id that is not a UUID answers the same 404.                                                                                                                                                                                                                                                                                                                                                                                            | owner, 2026-10-07 |
| Q10 | Where are reversals specified?                                                             | Decided: In a separate spec, `004-reversals`, because they are an operator action with their own rules (status of the accounts, a reversal that would overdraw, reversing twice). Specs 000, 001 and 002 point to it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | owner, 2026-10-07 |
| Q11 | Which accounts does the audit record of a movement list?                                   | Decided: The customer accounts involved: the account of a deposit or withdrawal, and the source and destination of a transfer. The settlement account follows from the action.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | owner, 2026-10-07 |
