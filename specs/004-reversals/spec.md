# 004 · Reversals

- **Status:** Draft
- **ID prefix:** REV
- **Related ADRs:** none yet (phase 03-adrs)
- **Depends on specs:** 000-overview, 001-accounts, 002-ledger, 003-money-movements, 005-idempotency

## 1. Context and goal

The ledger is append-only (SYS-R15), so a deposit, withdrawal or transfer that should not have happened (a duplicate from a payment rail, an operator's mistake, fraud) cannot be edited or deleted. It is corrected by a **reversal**: an operator records a new, compensating transaction whose entries are the exact negation of the original's, on the same accounts, linked to the original. The original stays as it was, and the two together have no net effect on any account. A transaction is reversed at most once, a reversal is never reversed itself, and a reversal never takes a customer account below zero.

Only operators reverse. A reversal is a money movement: one database transaction, an `Idempotency-Key` (spec 005), row locks in the same order as a transfer (spec 003), and one audit record, which also stores the operator's reason. Terms have the meanings in the glossary of spec 000. Requirements marked with a question number, for example "(Q3)", follow the recommended answer of that open question until the owner decides; "(000 Q7)" refers to an open question of spec 000.

### 1.1 Operation

The path is proposed here (Q1) and becomes final in the OpenAPI document (phase 08-api).

| Operation             | Method and path                     | Body         | Caller   |
| --------------------- | ----------------------------------- | ------------ | -------- |
| Reverse a transaction | `POST /transactions/{id}/reversals` | `{"reason"}` | Operator |

`reason` is a JSON string of 3 to 500 characters (Q4). The reversal carries no amount or currency of its own: both come from the original transaction.

### 1.2 Entries of a reversal

For an original transaction T of amount A (a positive number of minor units) in currency C, where S(C) is the settlement account of C, the reversal R has kind `reversal`, currency C, the link `reversedTransactionId` = T, and these entries (table 1.1 of spec 002 with the signs flipped):

| T is a     | T's entries                             | R's entries                             | R debits                           |
| ---------- | --------------------------------------- | --------------------------------------- | ---------------------------------- |
| deposit    | +A on the customer account, −A on S(C)  | −A on the customer account, +A on S(C)  | the customer account               |
| withdrawal | −A on the customer account, +A on S(C)  | +A on the customer account, −A on S(C)  | S(C) only, which may go below zero |
| transfer   | −A on the source, +A on the destination | +A on the source, −A on the destination | the destination                    |

### 1.3 Reversal response

A reversal that is applied answers 201 with a `Location: /transactions/<id>` header and this body:

| Field                   | Meaning                                                                          |
| ----------------------- | -------------------------------------------------------------------------------- |
| `id`                    | The reversal's transaction id, a UUIDv7 string.                                  |
| `kind`                  | `reversal`.                                                                      |
| `amount`                | The amount of the original transaction, a string of decimal digits without sign. |
| `currency`              | The currency of the original transaction.                                        |
| `createdAt`             | When the reversal was recorded, RFC 3339 in UTC with milliseconds (001 Q13).     |
| `reversedTransactionId` | The id of the original transaction.                                              |

The body carries no balance, because the operator owns no account (as a deposit, 003 Q3), and no `reason` (Q5).

### 1.4 Order of checks

Within the order of SYS-R31, the checks of a reversal run in this order and the first failure answers (Q6):

1. Validation of the request body (422 `/problems/validation-error`): `reason`, and no unknown member.
2. Lookup of the transaction in the path, including the check that its id is a UUID (404 `/problems/not-found`, SYS-R42).
3. Kind of that transaction: a reversal cannot be reversed (422 `/problems/transaction-not-reversible`). The kind never changes, so it is safe to check before the locks.
4. Row locks on every customer account with an entry in the original transaction, one by one in ascending id order (503 on lock timeout). The account lock timeout applies from this step on, after the idempotency record is written.
5. An existing reversal of the transaction (409 `/problems/already-reversed`).
6. Status of every locked account: `closed` fails (422 `/problems/account-not-active`); `active` and `frozen` pass.
7. Funds of every customer account the reversal debits (422 `/problems/insufficient-funds-for-reversal`).
8. Balance limit of every customer account the reversal credits (422 `/problems/balance-limit-exceeded`, spec 002).

Steps 5 to 8 read the database only after every lock of step 4 is held.

## 2. Requirements

| ID      | Requirement (EARS)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REV-R01 | WHEN an operator reverses a deposit, withdrawal or transfer T that has no reversal, with a valid `reason`, THE SYSTEM SHALL record one new transaction of kind `reversal`, in T's currency, linked to T by `reversedTransactionId`, whose entries are T's entries with their signs flipped, on the same accounts (table 1.2); change the cached balance of each customer account involved by the sum of its entries in it (LED-R11); and answer 201 with the `Location` header and body of section 1.3. |
| REV-R02 | WHEN a transaction is reversed THE SYSTEM SHALL leave the original transaction and its entries unchanged, so that whether a transaction was reversed follows only from the existence of its reversal (SYS-R15).                                                                                                                                                                                                                                                                                         |
| REV-R03 | IF a customer requests a reversal THEN THE SYSTEM SHALL answer 403 with problem type `/problems/forbidden`, with the same body whatever transaction id the path names, whether it involves the customer's own account, another customer's, no transaction or no UUID at all, and write nothing (SYS-R04, SYS-R31).                                                                                                                                                                                      |
| REV-R04 | IF an operator reverses a transaction that does not exist, or whose id in the path is not a UUID, THEN THE SYSTEM SHALL answer 404 with problem type `/problems/not-found`, with bodies that differ only in `requestId`, and write nothing (SYS-R42).                                                                                                                                                                                                                                                   |
| REV-R05 | THE SYSTEM SHALL let a transaction have at most one reversal, enforced by a unique database constraint on the reversal's link to the transaction it reverses, whatever the code that writes it.                                                                                                                                                                                                                                                                                                         |
| REV-R06 | IF an operator reverses a transaction that already has a reversal THEN THE SYSTEM SHALL answer 409 with problem type `/problems/already-reversed` and write no transaction, ledger entry, balance change or audit record, also when the unique constraint of REV-R05 rejects the insert, and never answer 500 for it.                                                                                                                                                                                   |
| REV-R07 | IF an operator reverses a transaction of kind `reversal` THEN THE SYSTEM SHALL answer 422 with problem type `/problems/transaction-not-reversible` and write nothing (Q3).                                                                                                                                                                                                                                                                                                                              |
| REV-R08 | IF a reversal would debit a customer account by more than its cached balance, read while its row lock is held, THEN THE SYSTEM SHALL answer 422 with problem type `/problems/insufficient-funds-for-reversal`, write no transaction, ledger entry, balance change or audit record, and leave every balance unchanged (SYS-R12, Q2).                                                                                                                                                                     |
| REV-R09 | WHILE a customer account with an entry in the original transaction is `frozen` THE SYSTEM SHALL apply the reversal as for an `active` account, and leave the account `frozen` (Q7).                                                                                                                                                                                                                                                                                                                     |
| REV-R10 | IF a customer account with an entry in the original transaction is `closed` THEN THE SYSTEM SHALL answer 422 with problem type `/problems/account-not-active` and write no transaction, ledger entry, balance change or audit record (Q7).                                                                                                                                                                                                                                                              |
| REV-R11 | IF a reversal would make the cached balance of a customer account greater than 9223372036854775807 THEN THE SYSTEM SHALL answer 422 with problem type `/problems/balance-limit-exceeded` and write no transaction, ledger entry, balance change or audit record (LED-R26, SYS-R40).                                                                                                                                                                                                                     |
| REV-R12 | THE SYSTEM SHALL not apply `MAX_AMOUNT_MINOR` to a reversal, so that a transaction accepted earlier can always be reversed after the maximum is lowered (002 Q2).                                                                                                                                                                                                                                                                                                                                       |
| REV-R13 | IF a reversal request has no `Idempotency-Key` header, or a malformed one, THEN THE SYSTEM SHALL answer 400 with problem type `/problems/malformed-request` and write nothing (SYS-R26). The semantics of the key, including replay, are defined in spec 005.                                                                                                                                                                                                                                           |
| REV-R14 | IF the `reason` of a reversal request is missing, is not a JSON string, has fewer than 3 or more than 500 Unicode code points, contains a control character (U+0000 to U+001F or U+007F), or contains only whitespace, or the body has any other member, THEN THE SYSTEM SHALL answer 422 with problem type `/problems/validation-error` and one `errors` entry for each failing field, and write nothing (SYS-R27, Q4).                                                                                |
| REV-R15 | WHEN a reversal commits THE SYSTEM SHALL write, in the same database transaction, one audit record with the acting operator, their role, the action `reversal`, the customer accounts involved, the reversal's transaction id, the reversed transaction id, the `reason` exactly as sent, the correlation id and the time (SYS-R23, Q8). A rejected reversal writes no audit record.                                                                                                                    |
| REV-R16 | THE SYSTEM SHALL return the `reason` of a reversal in no response, including the reversal response and the transaction representation, and write it to no log line (Q5).                                                                                                                                                                                                                                                                                                                                |
| REV-R17 | THE SYSTEM SHALL apply each reversal in one database transaction whose first write is the idempotency record (spec 005), followed by the row locks, the transaction and its ledger entries, the cached balance changes and the audit record, so that all of them commit together or none does (SYS-R11).                                                                                                                                                                                                |
| REV-R18 | THE SYSTEM SHALL lock every customer account with an entry in the original transaction with `SELECT ... FOR UPDATE`, one by one in ascending id order in canonical lowercase form, exactly as a transfer does (MOV-R18, MOV-R30), never lock or update a system account's row (LED-R14), and read the existing reversal, the statuses and the balances used by the checks only after all those locks are held.                                                                                          |
| REV-R19 | THE SYSTEM SHALL bound the wait for each account row lock of a reversal by `ACCOUNT_LOCK_TIMEOUT_MS`, applied as for a movement (MOV-R19); IF a lock is not acquired in time THEN THE SYSTEM SHALL roll back the reversal's database transaction, so that no transaction, ledger entry, balance change, idempotency record or audit record remains, and answer 503 with problem type `/problems/service-unavailable` and the header `Retry-After: 1` (MOV-R20).                                         |
| REV-R20 | WHEN reversals run concurrently with deposits, withdrawals and transfers on the same accounts THE SYSTEM SHALL complete them without a deadlock error, a 500 or a 503 reaching the client, relying on the lock order of REV-R18 and the retry of SYS-R18, and accept only debits that the balance covers at the moment their locks are held, so that no customer account's balance is ever below zero (SYS-R17, MOV-R22).                                                                               |
| REV-R21 | WHEN several reversals of the same transaction run concurrently, each with its own `Idempotency-Key`, THE SYSTEM SHALL apply exactly one of them and answer every other with 409 and problem type `/problems/already-reversed`.                                                                                                                                                                                                                                                                         |
| REV-R22 | THE SYSTEM SHALL run the checks of a reversal in the order of section 1.4 and answer the first that fails (Q6).                                                                                                                                                                                                                                                                                                                                                                                         |
| REV-R23 | WHEN a transaction of kind `reversal` is read by id (MOV-R26, MOV-R27) THE SYSTEM SHALL answer with the representation of section 1.3 of spec 003, with `kind` "reversal", plus the member `reversedTransactionId`, showing a customer only the entries of their own accounts.                                                                                                                                                                                                                          |

## 3. Acceptance criteria

Unless stated otherwise: customer user C1 owns account A1 (EUR), customer user C2 owns account B1 (EUR), customer user C3 owns account Z1 (EUR), operator user O1 is an operator, balances are set up by deposits from O1, every POST carries a fresh Idempotency-Key, every reversal request has the body `{"reason": "Operator correction"}`, S is the EUR settlement account, U is a transaction id that does not exist, and `MAX_AMOUNT_MINOR` is unset. The balance of S, the sum of its entries, is asserted only as a change during a test (spec 002, LED Q7).

### REV-AC01 · Reversing a deposit

- **Level:** integration
- **Covers:** REV-R01, REV-R02, REV-R16
- **Given** A1 with "0" EUR; O1 deposits "5000" EUR into A1 as transaction D; and the balance of S is read
- **When** O1 reverses D with `{"reason": "Duplicate deposit from rail"}`
- **Then** the answer is 201 with `Location: /transactions/<r>` and a body with exactly `id` <r>, `kind` "reversal", `amount` "5000", `currency` "EUR", `createdAt` and `reversedTransactionId` D, and no `balance` or `reason`; A1 is "0" EUR; transaction <r> has exactly the entries "-5000" on A1 and "5000" on S; the balance of S is "5000" EUR higher than before the reversal; D, read by O1, still has `kind` "deposit", `amount` "5000", the same `createdAt` and exactly the entries "5000" on A1 and "-5000" on S; and C1's history of A1 lists `kind` "reversal" with `amount` "-5000" first and `kind` "deposit" with `amount` "5000" second

### REV-AC02 · Reversing a withdrawal and a transfer

- **Level:** integration
- **Covers:** REV-R01
- **Given** A1 with "5000" EUR and B1 with "0" EUR; C1 withdraws "1200" EUR from A1 as transaction W, then transfers "300" EUR from A1 to B1 as transaction T, leaving A1 "3500" EUR and B1 "300" EUR; and the balance of S is read
- **When** O1 reverses W, then reverses T
- **Then** both answer 201 with `kind` "reversal"; W's reversal has exactly the entries "1200" on A1 and "-1200" on S, and `reversedTransactionId` W; T's reversal has exactly the entries "300" on A1 and "-300" on B1, no entry on a system account, and `reversedTransactionId` T; A1 is "5000" EUR and B1 "0" EUR; and the balance of S is "1200" EUR lower than before the reversals

### REV-AC03 · The domain builds a reversal as the negation of the original

- **Level:** unit
- **Covers:** REV-R01, REV-R07
- **Given** domain transactions: a deposit D of 1050n EUR into A1, a withdrawal W of 1200n EUR from A1, a transfer T of 300n EUR from A1 to B1, and R, the reversal of D
- **When** the domain builds the reversal of D, of W, of T and of R
- **Then** each of the first three has kind `reversal`, currency EUR, the link to its original's id, and exactly its original's entries on the same accounts with the signs flipped (−1050n on A1 and +1050n on S; +1200n on A1 and −1200n on S; +300n on A1 and −300n on B1), all `bigint`; D, W and T are deeply equal to themselves before the call; and the reversal of R is refused with the typed not-reversible domain error and no transaction is returned

### REV-AC04 · Only operators reverse, and a customer learns nothing from the 403

- **Level:** integration
- **Covers:** REV-R03
- **Given** A1 with "1000" EUR after O1's deposit D; B1 with "0" EUR; C1 transfers "100" EUR from A1 to B1 as T; and O1 reverses that transfer as R
- **When** C1 reverses D, T and R; C2 reverses D; and C1 reverses U and "not-a-uuid"
- **Then** all six answer 403 with type `/problems/forbidden` and bodies equal except for `requestId`; D has no reversal; A1 stays "1000" EUR and B1 "0" EUR; and no transaction or audit record is added

### REV-AC05 · Reversing an unknown transaction answers 404

- **Level:** integration
- **Covers:** REV-R04
- **Given** A1 with "1000" EUR, whose id is not a transaction id
- **When** O1 reverses U, "not-a-uuid" and A1's id used as a transaction id
- **Then** all three answer 404 with type `/problems/not-found` and bodies equal except for `requestId`; A1 stays "1000" EUR; and no transaction or audit record is added

### REV-AC06 · A transaction is reversed at most once

- **Level:** integration
- **Covers:** REV-R05, REV-R06
- **Given** A1 with "0" EUR; O1 deposits "1000" EUR into A1 as D, then reverses D with Idempotency-Key k1 as R1, leaving A1 "0" EUR; then O1 deposits "1000" EUR into A1 again, leaving A1 "1000" EUR
- **When** O1 reverses D again with Idempotency-Key k2; and then a second reversal of D, with the balanced entries "-1000" on A1 and "1000" on S, is written directly to the database by the service's runtime role
- **Then** the request answers 409 with type `/problems/already-reversed`; the direct write is rejected by the unique constraint and none of its rows is stored; A1 stays "1000" EUR; exactly one reversal of D exists, R1; and no audit record exists for k2

### REV-AC07 · Concurrent reversals of the same transaction apply once

- **Level:** integration
- **Covers:** REV-R05, REV-R21
- **Given** A1 with "0" EUR; O1 deposits "1000" EUR into A1 as D
- **When** O1 sends 10 reversals of D at the same time, each with its own Idempotency-Key
- **Then** exactly 1 answers 201 and 9 answer 409 with type `/problems/already-reversed`; no response is a 5xx; A1 is "0" EUR; exactly one reversal of D and one audit record of action `reversal` for D exist; and the reconciliation of spec 002 reports no discrepancy

### REV-AC08 · The unique constraint answers 409, never 500

- **Level:** integration
- **Covers:** REV-R06
- **Given** the test app (SYS-R37) with a fault-injection hook that skips step 5 of section 1.4, the check for an existing reversal; A1 with "2000" EUR after two deposits by O1, D of "1000" EUR and a later one of "1000" EUR; and D reversed once by O1, leaving A1 "1000" EUR
- **When** O1 reverses D again with Idempotency-Key k2
- **Then** the insert of the second reversal is rejected by the unique constraint of REV-R05; the answer is 409 with type `/problems/already-reversed`, not 500; A1 stays "1000" EUR; and no transaction, ledger entry or audit record exists for k2

### REV-AC09 · A reversal cannot be reversed

- **Level:** integration
- **Covers:** REV-R07
- **Given** A1 with "0" EUR; O1 deposits "1000" EUR into A1 as D and reverses D as R
- **When** O1 reverses R
- **Then** the answer is 422 with type `/problems/transaction-not-reversible`; A1 stays "0" EUR; R has no reversal; and no transaction or audit record is added

### REV-AC10 · Money already spent cannot be reversed

- **Level:** integration
- **Covers:** REV-R08
- **Given** A1 with "0" EUR and B1 with "0" EUR; O1 deposits "1000" EUR into A1 as D; C1 withdraws "600" EUR from A1, leaving A1 "400" EUR; C1 transfers "300" EUR from A1 to B1 as T, leaving A1 "100" EUR and B1 "300" EUR; and C2 withdraws "250" EUR from B1, leaving B1 "50" EUR
- **When** O1 reverses D and T; then O1 deposits "900" EUR into A1 and "250" EUR into B1; then O1 reverses D and T again, each with a fresh Idempotency-Key
- **Then** the first two reversals answer 422 with type `/problems/insufficient-funds-for-reversal`, A1 stays "100" EUR and B1 "50" EUR, and no transaction, ledger entry or audit record exists for either; after the deposits A1 is "1000" EUR and B1 "300" EUR; the second reversal of D answers 201 and leaves A1 "0" EUR; and the second reversal of T answers 201 and leaves A1 "300" EUR and B1 "0" EUR

### REV-AC11 · A frozen account can be reversed and stays frozen

- **Level:** integration
- **Covers:** REV-R09
- **Given** A1 with "0" EUR and B1 with "0" EUR; O1 deposits "1000" EUR into A1 as D; C1 transfers "400" EUR from A1 to B1 as T; then O1 freezes A1 and B1
- **When** O1 reverses T, then reverses D
- **Then** both answer 201; after T's reversal A1 is "1000" EUR and B1 "0" EUR; after D's reversal A1 is "0" EUR; and A1 and B1 are still `frozen`

### REV-AC12 · A closed account blocks the reversal

- **Level:** integration
- **Covers:** REV-R10
- **Given** C1 owns X1 with "0" EUR and A1 with "1000" EUR; C2 owns X2 with "0" EUR; O1 deposits "500" EUR into X1 as D; C1 withdraws "500" EUR from X1 as W; C1 transfers "300" EUR from A1 to X2 as T, and C2 withdraws "300" EUR from X2; then O1 closes X1 and X2, both at "0" EUR, and A1 is "700" EUR
- **When** O1 reverses D, W and T
- **Then** each answers 422 with type `/problems/account-not-active`; X1 and X2 stay `closed` with "0" EUR and A1 stays "700" EUR; and no transaction, ledger entry or audit record is added

### REV-AC13 · A reversal that would overflow a balance is refused

- **Level:** integration
- **Covers:** REV-R11
- **Given** the service started with `MAX_AMOUNT_MINOR` "9223372036854775807"; A1 with "0" EUR; O1 deposits "100" EUR into A1; C1 withdraws "100" EUR from A1 as W; then O1 deposits "9223372036854775807" EUR into A1
- **When** O1 reverses W
- **Then** the answer is 422 with type `/problems/balance-limit-exceeded`, not 500; A1 stays "9223372036854775807" EUR; W has no reversal; and no transaction, ledger entry or audit record is added

### REV-AC14 · The maximum amount does not limit a reversal

- **Level:** integration
- **Covers:** REV-R12
- **Given** the service started with `MAX_AMOUNT_MINOR` unset; A1 with "0" EUR; and O1 deposits "1000" EUR into A1 as D
- **When** the service is restarted against the same database with `MAX_AMOUNT_MINOR` "100", and O1 reverses D
- **Then** the answer is 201 with `amount` "1000", and A1 is "0" EUR

### REV-AC15 · A reversal requires an Idempotency-Key, and a retry replays

- **Level:** integration
- **Covers:** REV-R13
- **Given** A1 with "0" EUR; O1 deposits "1000" EUR into A1 as D
- **When** O1 reverses D without an `Idempotency-Key` header, then with an empty one, then with Idempotency-Key k1, then sends the same request with k1 again
- **Then** the first two answer 400 with type `/problems/malformed-request` and write nothing; the third answers 201; the fourth answers 201 with the third's body unchanged, including its `requestId`, and the header `Idempotent-Replayed: true`, not 409; A1 is "0" EUR; and exactly one reversal of D and one audit record for it exist

### REV-AC16 · Reason validation

- **Level:** unit
- **Covers:** REV-R14
- **Given** the reversal request schema
- **When** it validates the bodies with `reason` "abc", two spaces followed by "a" (3 code points), "Duplicate deposit from rail", 500 × "é" (each the single code point U+00E9), and 500 × "👍" (1000 UTF-16 code units); and then the bodies `{}`, `reason` "", "ab", three spaces, 501 × "a", "👍👍" (4 UTF-16 code units), "a\u0000bc", "line one\nline two", "abc\u007f", the JSON number 42 and `null`, and `{"reason": "abc", "amount": "5"}`
- **Then** the first five are accepted with `reason` unchanged; each of the others is rejected with exactly one `errors` entry, whose pointer is `/reason`, except the last, whose only entry has pointer `/amount`

### REV-AC17 · An invalid reason writes nothing

- **Level:** integration
- **Covers:** REV-R14
- **Given** A1 with "0" EUR; O1 deposits "1000" EUR into A1 as D
- **When** O1 reverses D with the bodies `{}`, `{"reason": "ab"}`, `{"reason": 42}` and `{"reason": "abc", "amount": "5"}`, and then with `{"reason": "abc"}`
- **Then** the first four answer 422 with type `/problems/validation-error` and one `errors` entry, with pointer `/reason` for the first three and `/amount` for the fourth, and add no transaction or audit record; and the last answers 201, leaving A1 "0" EUR

### REV-AC18 · Each reversal writes one audit record with its reason

- **Level:** integration
- **Covers:** REV-R15, REV-R16
- **Given** A1 with "0" EUR and B1 with "0" EUR; O1 deposits "1000" EUR into A1 as D; C1 transfers "300" EUR from A1 to B1 as T
- **When** O1 reverses T with `{"reason": "Fraud ticket #4411: card testing"}`, `X-Request-Id: req-rev` and Idempotency-Key k1; O1 reverses T again with k2; O1 reverses D with k3, which debits all "1000" EUR that A1 holds, and then reverses D again with k4; and C1 reads T's reversal by id
- **Then** exactly one audit record exists for k1: actor O1, role operator, action `reversal`, accounts A1 and B1, the reversal's transaction id from the response, reversed transaction id T, reason "Fraud ticket #4411: card testing" exactly, correlation id "req-rev" and a time; k3's reversal has its own audit record; the 409 for k2 and the 409 for k4 have none; no response body of this test, including C1's read, contains "Fraud ticket"; and no log line written while handling k1 contains "Fraud ticket"

### REV-AC19 · A reversal is all or nothing

- **Level:** integration
- **Covers:** REV-R17
- **Given** the test app (SYS-R37) with a fault injected after the ledger entries and balance changes of a reversal are written and before its audit record; A1 with "1000" EUR and B1 with "0" EUR; C1 transfers "300" EUR from A1 to B1 as T
- **When** O1 reverses T with Idempotency-Key k1, and then repeats it with k1 after the fault is removed
- **Then** the first answers 500 with type `/problems/internal-error`, and afterwards no transaction, ledger entry, idempotency record or audit record exists for k1, T has no reversal, and A1 is "700" EUR and B1 "300" EUR; the repeat answers 201; and A1 is "1000" EUR and B1 "0" EUR, with exactly one reversal of T

### REV-AC20 · Reversal locks are planned like a transfer's

- **Level:** unit
- **Covers:** REV-R18
- **Given** customer account ids a = "018f2a00-0000-7000-8000-00000000000a" and b = "018f2a00-0000-7000-8000-00000000000b", b also written in uppercase as "018F2A00-0000-7000-8000-00000000000B", and the settlement account S
- **When** the lock plan is computed for the reversal of a transfer from b in uppercase to a, the reversal of a transfer from a to b, the reversal of a deposit into b in uppercase and the reversal of a withdrawal from a
- **Then** both transfer reversals lock a then b, in canonical lowercase form, the same plan as the transfers themselves (MOV-AC15); the deposit reversal locks only b, in lowercase; the withdrawal reversal locks only a; and no plan contains S

### REV-AC21 · An account lock that is not acquired in time

- **Level:** integration
- **Covers:** REV-R19
- **Given** the service started with `ACCOUNT_LOCK_TIMEOUT_MS` "200"; A1 with "0" EUR; O1 deposits "1000" EUR into A1 as D; and a separate database session that holds `SELECT ... FOR UPDATE` on A1's row
- **When** O1 reverses D with Idempotency-Key k1; then the session releases its lock; then O1 repeats the reversal with k1
- **Then** the first answers 503 with type `/problems/service-unavailable` and `Retry-After: 1`, after at least 200 ms and in less than 5 seconds, and afterwards no transaction, ledger entry, idempotency record or audit record exists for k1 and A1 is "1000" EUR; the repeat answers 201; and A1 is "0" EUR with exactly one reversal of D

### REV-AC22 · A reversal racing a transfer never overdraws

- **Level:** integration
- **Covers:** REV-R18, REV-R20
- **Given** A1 with "5000" EUR and B1 with "0" EUR; C1 transfers "1000" EUR from A1 to B1 as T, leaving A1 "4000" EUR and B1 "1000" EUR
- **When** at the same time O1 reverses T and C2 transfers "600" EUR from B1 to A1; and the run is repeated 20 times on fresh accounts
- **Then** in every run exactly one of these holds: the reversal answers 201, the transfer answers 422 with type `/problems/insufficient-funds`, and A1 is "5000" EUR and B1 "0" EUR; or the transfer answers 201, the reversal answers 422 with type `/problems/insufficient-funds-for-reversal`, and A1 is "4600" EUR and B1 "400" EUR; no response is a 5xx; and the reconciliation of spec 002 reports no discrepancy

### REV-AC23 · Reversals and crossed transfers never deadlock

- **Level:** integration
- **Covers:** REV-R20
- **Given** A1 and B1 with "100000" EUR each; C1 transfers "100" EUR from A1 to B1 20 times, as T1 to T20, leaving A1 "98000" EUR and B1 "102000" EUR
- **When** at the same time O1 reverses T1 to T20, C1 sends 50 transfers of "1000" EUR from A1 to B1, and C2 sends 50 transfers of "1000" EUR from B1 to A1
- **Then** all 120 answer 201 and no response is a 5xx; A1 and B1 are "100000" EUR each; each of T1 to T20 has exactly one reversal; and the reconciliation of spec 002 reports no discrepancy

### REV-AC24 · Checks run in a fixed order

- **Level:** integration
- **Covers:** REV-R22
- **Given** C1 owns X1 and X2, both with "0" EUR; O1 deposits "500" EUR into X1 as D1 and reverses it as R1; O1 deposits "500" EUR into X2 as D2, and C1 withdraws "500" EUR from X2; then O1 closes X1 and X2
- **When** O1 reverses U with `{"reason": "ab"}`; O1 reverses R1 with `{"reason": "ab"}`; O1 reverses R1 with a valid reason; O1 reverses D1, which is already reversed and on a `closed` account; and O1 reverses D2, which is on a `closed` account that lacks the funds
- **Then** they answer, in that order, 422 `/problems/validation-error`, 422 `/problems/validation-error`, 422 `/problems/transaction-not-reversible`, 409 `/problems/already-reversed` and 422 `/problems/account-not-active`; and no transaction or audit record is added

### REV-AC25 · Reading a reversal

- **Level:** integration
- **Covers:** REV-R23
- **Given** A1 with "1000" EUR and B1 with "0" EUR; C1 transfers "300" EUR from A1 to B1 as T; and O1 reverses T as R
- **When** O1, C1, C2 and C3 each read R by id
- **Then** O1 gets 200 with `kind` "reversal", `amount` "300", `currency` "EUR", `reversedTransactionId` T and exactly the entries "300" on A1 and "-300" on B1; C1 gets 200 with `reversedTransactionId` T and only the entry "300" on A1; C2 gets 200 with `reversedTransactionId` T and only the entry "-300" on B1, and no member holding A1's id; and C3 gets 404 with type `/problems/not-found`

## 4. Error catalogue

Errors shared by every capability are in spec 000. For a reversal:

| Condition                                                                                                                                   | HTTP | Problem type                              | Stored for idempotent replay |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------- | ---------------------------- |
| No `Idempotency-Key`, or a malformed one                                                                                                    | 400  | /problems/malformed-request               | no                           |
| A customer requests a reversal, whatever transaction id it names                                                                            | 403  | /problems/forbidden                       | no                           |
| `reason` missing, not a string, outside 3 to 500 code points, with a control character or only whitespace, or an unknown member in the body | 422  | /problems/validation-error                | no                           |
| The transaction in the path does not exist, or its id is not a UUID                                                                         | 404  | /problems/not-found                       | yes                          |
| The transaction is itself a reversal                                                                                                        | 422  | /problems/transaction-not-reversible      | yes                          |
| The transaction already has a reversal, including when the unique constraint rejects the insert                                             | 409  | /problems/already-reversed                | yes                          |
| A customer account with an entry in the transaction is `closed`                                                                             | 422  | /problems/account-not-active              | yes                          |
| The reversal would debit a customer account by more than its balance                                                                        | 422  | /problems/insufficient-funds-for-reversal | yes                          |
| The reversal would make a customer account's balance exceed 9223372036854775807 (LED-R26)                                                   | 422  | /problems/balance-limit-exceeded          | yes                          |
| An account row lock is not acquired within `ACCOUNT_LOCK_TIMEOUT_MS`, answered with `Retry-After: 1`                                        | 503  | /problems/service-unavailable             | no                           |
| The same `Idempotency-Key` is still in progress after the idempotency wait timeout of spec 005, answered with `Retry-After: 1`              | 409  | /problems/request-in-progress             | no                           |

## 5. Invariants

- A transaction has at most one reversal, and a reversal has none (REV-AC06, REV-AC07, REV-AC09).
- A reversal's entries are exactly its original's entries with the signs flipped, on the same accounts, so an original and its reversal together leave every account's balance as it was before the original (REV-AC01, REV-AC02, REV-AC03).
- An original transaction and its entries are never changed by its reversal (REV-AC01).
- No reversal writes an entry on a `closed` account or takes a customer account below zero (REV-AC10, REV-AC12, REV-AC22).
- Every applied reversal has exactly one audit record, holding its reason; a rejected one has none (REV-AC18).
- The invariants of specs 000, 001, 002 and 003 hold before and after every operation of this spec.

## 6. Out of scope

- Partial reversals, and reversing several transactions in one request.
- Undoing a reversal: a reversal applied by mistake is corrected by a new deposit or transfer, not by reversing it (Q3).
- Letting a reversal take a customer account below zero, and any notion of debt or overdraft (Q2).
- Disputes or chargebacks requested by customers, and notifications to customers.
- Approval by a second operator (four-eyes) and time limits on reversals (Q10).
- Reading or searching audit records through the API.
- A link from the original transaction to its reversal in the original's representation (Q9).

## 7. Open questions

| #   | Question                                                                                                                                                 | Recommended answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Decided by        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| Q1  | What is the path of a reversal?                                                                                                                          | Decided: `POST /transactions/{id}/reversals` with `{"reason"}`. The transaction acted on is in the path, so SYS-R31's lookup step has one resource to check, as for the movements of spec 003 (003 Q1).                                                                                                                                                                                                                                                                                                      | owner, 2026-10-07 |
| Q2  | When the reversal would take a customer account below zero because the money was already spent, is it rejected, or allowed as a negative balance (debt)? | Decided: rejected with 422 `/problems/insufficient-funds-for-reversal`, nothing written. Alternative recorded: allow the balance to go negative and treat it as debt the customer owes. That breaks SYS-R12 and the database constraint of LED-R12 for every account, and needs a debt model (who may go negative, how far, how it is collected and reported) that this service does not have. With the rejection, the operator first recovers the money (for example by a later deposit) and then reverses. | owner, 2026-10-07 |
| Q3  | Which answer does reversing a reversal get, and how is a mistaken reversal undone?                                                                       | Decided: 422 `/problems/transaction-not-reversible`: it is a refusal by rule, not a conflict with the current state, since a reversal is never reversible. A mistaken reversal is corrected by a new deposit or transfer, so the ledger never holds chains of reversals.                                                                                                                                                                                                                                     | owner, 2026-10-07 |
| Q4  | How is the length of `reason` counted, and which characters are allowed?                                                                                 | Decided: Unicode code points of the string as sent, without trimming, so an emoji counts as one character and the limit does not depend on the encoding. Reject control characters (U+0000 to U+001F and U+007F), because PostgreSQL `text` cannot store U+0000 and a reason is one line; reject a reason made only of whitespace, because it records nothing.                                                                                                                                               | owner, 2026-10-07 |
| Q5  | Who can see the `reason`?                                                                                                                                | Decided: Only the audit record holds it. It is returned in no response and written to no log line, because it may hold fraud notes or personal data; customers never see it.                                                                                                                                                                                                                                                                                                                                 | owner, 2026-10-07 |
| Q6  | In which order are the checks of a reversal run?                                                                                                         | Decided: The order of section 1.4. Static checks first (body, lookup, kind); then the locks; then the existing reversal, because a second attempt should learn that first, whatever the accounts' state now; then status, funds and the balance limit, in the order spec 003 uses.                                                                                                                                                                                                                           | owner, 2026-10-07 |
| Q7  | Which account statuses block a reversal?                                                                                                                 | Decided: `frozen` does not, because operators often freeze an account in order to correct it, for example for fraud; `closed` does, with 422 `/problems/account-not-active`, because a closed account keeps balance "0" and never changes again. This also answers 001 Q7.                                                                                                                                                                                                                                   | owner, 2026-10-07 |
| Q8  | What does the audit record of a reversal hold?                                                                                                           | Decided: The fields of SYS-R23, the customer accounts involved (as 003 Q11), the reversed transaction id and the reason.                                                                                                                                                                                                                                                                                                                                                                                     | owner, 2026-10-07 |
| Q9  | Does the original transaction show its reversal, and does the 409 name it?                                                                               | Decided: Not in this version. The reversal carries `reversedTransactionId`, and an operator finds it through the account history, whose entries carry `kind` "reversal" and the `transactionId`. The 409 body has no extra member.                                                                                                                                                                                                                                                                           | owner, 2026-10-07 |
| Q10 | Is there a time limit on reversals, or a second approval?                                                                                                | Decided: No, in this version. Both are policy that the owner has not stated; they can be added as new requirements later.                                                                                                                                                                                                                                                                                                                                                                                    | owner, 2026-10-07 |
| Q11 | Is a 409 `/problems/already-reversed` stored for idempotent replay?                                                                                      | Decided: in spec 005, together with the 422 business rejections (000 Q7), so every rejection decided after the locks follows one rule; spec 000's error catalogue points there. Spec 005 must also cover the case where the unique constraint aborts the database transaction, which takes the idempotency record with it.                                                                                                                                                                                   | owner, 2026-10-07 |
