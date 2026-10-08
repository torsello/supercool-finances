# 002 · Ledger

- **Status:** Approved
- **ID prefix:** LED
- **Related ADRs:** [ADR-0001](../../docs/adr/0001-spec-driven-development-with-adrs-and-ai-agents.md), [ADR-0002](../../docs/adr/0002-modular-monolith.md), [ADR-0003](../../docs/adr/0003-hexagonal-architecture-with-tactical-ddd.md), [ADR-0005](../../docs/adr/0005-postgresql-as-the-only-source-of-truth.md), [ADR-0006](../../docs/adr/0006-double-entry-ledger-with-signed-integer-minor-units.md), [ADR-0007](../../docs/adr/0007-system-accounts-without-a-cached-balance.md), [ADR-0008](../../docs/adr/0008-read-committed-with-ordered-pessimistic-row-locks.md), [ADR-0010](../../docs/adr/0010-kysely-and-pg-instead-of-an-orm.md), [ADR-0011](../../docs/adr/0011-amounts-as-strings-in-the-api-and-bigint-in-the-domain.md), [ADR-0016](../../docs/adr/0016-error-model.md), [ADR-0017](../../docs/adr/0017-keyset-pagination-with-signed-cursors.md), [ADR-0018](../../docs/adr/0018-two-database-roles.md), [ADR-0021](../../docs/adr/0021-statement-timeout-function-for-maintenance-scripts.md)
- **Depends on specs:** 000-overview, 001-accounts, 003-money-movements, 004-reversals, 005-idempotency

## 1. Context and goal

The ledger is the double-entry record of every money movement and the source of truth for where money went. Every deposit, withdrawal, transfer and reversal is written as one transaction of signed ledger entries that sum to zero, so money is never created or destroyed inside the service: it only enters or leaves through a settlement system account. The database itself enforces the rules that keep the ledger sound (balanced transactions, one currency, non-negative customer balances, immutability), so a defect in the code cannot commit a broken ledger. A reconciliation report proves, after every test run and on demand, that cached balances still match the ledger.

The users of this capability are the movements (specs 003 and 004), which write to the ledger, the account history (spec 001), which reads it, and operators and CI, which run the reconciliation. Terms (account, customer account, system account, amount, transaction, ledger entry, balance) have the meanings in the glossary of spec 000.

### 1.1 Entry shapes

For a movement of amount A (a positive number of minor units) in currency C, where S(C) is the settlement account of C:

| Kind       | Entries                                                                          |
| ---------- | -------------------------------------------------------------------------------- |
| deposit    | +A on the customer account, −A on S(C)                                           |
| withdrawal | −A on the customer account, +A on S(C)                                           |
| transfer   | −A on the source account, +A on the destination account; no system account entry |
| reversal   | the entries of the original transaction with their signs flipped (spec 004)      |

A positive amount credits the account (adds to its balance) and a negative amount debits it (subtracts from its balance) (the glossary of spec 000). A settlement account therefore goes below zero as money is deposited: its balance is minus the money that entered the service through it.

### 1.2 Records

| Record             | Holds                                                                                                                                                                                                                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transaction        | `id`, `kind` (`deposit`, `withdrawal`, `transfer` or `reversal`), `currency`, `createdAt`, and for a reversal the id of the transaction it reverses (spec 004).                                                                                                                                                                  |
| Ledger entry       | `id`, `transactionId`, `accountId`, `amount` (signed `bigint`, never 0), `currency`, `createdAt`.                                                                                                                                                                                                                                |
| Settlement account | A system account with a UUIDv7 `id` like every account (spec 001), a unique `code` `external-settlement:<currency>`, for example `external-settlement:USD`, its currency, no owner and no cached balance. The code is used by migrations, logs and the reconciliation, and is never accepted or returned by a customer endpoint. |

### 1.3 Database enforcement

- **Roles.** The database has two roles. The owner role runs the migrations and owns the tables. The runtime role, used by the service, holds SELECT and INSERT on transactions and ledger entries and only the privileges it needs on the other tables (LED-R16, LED-R17). Phase 05-schema replaces the single role `scf` that `docker/postgres/init` creates today.
- **Checks at commit.** A deferred constraint trigger (`DEFERRABLE INITIALLY DEFERRED`) on inserts into ledger entries and transactions checks, for each transaction, at least two entries, a zero sum and one currency (LED-R04 to LED-R07). Zero amounts, the entry's currency against its account's, the absence of a cached balance on system accounts and the non-negative cached balance of customer accounts are row constraints (LED-R03, LED-R07, LED-R12, LED-R13).
- **Foreign key lock on system accounts.** Inserting an entry on a system account makes PostgreSQL take `FOR KEY SHARE` on that account's row to check the foreign key. That lock is accepted: it is shared, never blocks another movement and does not conflict with LED-R14. The foreign key is kept, because integrity matters more than the multixact cost under load, which the load test (SYS-R20) measures.

### 1.4 Amount limits

- **Maximum per movement.** `MAX_AMOUNT_MINOR` is one value in minor units for every currency, applied to the amount of deposit, withdrawal and transfer requests (LED-R23). It is static configuration, so it is checked with the request schema at the validation step of SYS-R31, before the account lookup, answers `/problems/validation-error` and is not stored for replay (LED-R24). A reversal carries no amount of its own and is not limited, so a transaction accepted earlier can always be corrected after the maximum is lowered.
- **Balance limit.** A credit that would take a cached balance above 9223372036854775807 is checked in the domain after the row locks are held. A deposit or reversal answers `/problems/balance-limit-exceeded` (LED-R26). On a transfer, an overflowing destination answers exactly like any destination the sender cannot credit (LED-R29), so a sender never learns anything about another customer's balance.

### 1.5 Reconciliation

- **Snapshot.** The reconciliation runs in one read-only REPEATABLE READ database transaction against `DATABASE_URL`: a single snapshot, with no row locks (LED-R20).
- **Report.** The output is one JSON object with `discrepancies`, each with the account id, currency, cached balance, sum of entries and difference, and `totals`, one entry per currency of table 1.3 of spec 000, with "0" for a currency without entries. Every amount is a decimal string. Exit codes are 0 when clean, 1 for a discrepancy or a non-zero total, and 2 when it cannot run (LED-R21).
- **Global sum.** Per currency, the cached balances of customer accounts plus the sums of entries of system accounts, as in SYS-AC11, so a drift in a cached balance also shows in the total (LED-R19).
- **After every test run.** CI runs `npm run reconcile` against `TEST_DATABASE_URL` after the integration tests (LED-R22). Tests therefore share the test database and leave its committed data balanced: a test that needs a drift creates it inside a database transaction it rolls back (LED-AC14), or in a database created for it and dropped afterwards (LED-AC16), and asserts the balance of a settlement account only as a change during the test.

## 2. Requirements

| ID      | Requirement (EARS)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LED-R01 | THE SYSTEM SHALL record each money movement as one transaction holding its kind, its currency, its creation time and two or more ledger entries, each with an account, a signed `bigint` amount in minor units and the currency.                                                                                                                                                                                                                                                                                    |
| LED-R02 | THE SYSTEM SHALL store a credit as a positive entry amount and a debit as a negative one, and change an account's balance by exactly the sum of its entries (the glossary of spec 000).                                                                                                                                                                                                                                                                                                                             |
| LED-R03 | IF a ledger entry has amount 0 THEN THE SYSTEM SHALL reject it in the domain, and the database SHALL reject its insert.                                                                                                                                                                                                                                                                                                                                                                                             |
| LED-R04 | IF a transaction has fewer than two entries THEN THE SYSTEM SHALL reject it in the domain, and the database SHALL reject the commit of the database transaction that writes it.                                                                                                                                                                                                                                                                                                                                     |
| LED-R05 | IF the entries of a transaction do not sum to zero per currency THEN THE SYSTEM SHALL reject it in the domain, and the database SHALL reject the commit of the database transaction that writes it, so that none of its rows are stored.                                                                                                                                                                                                                                                                            |
| LED-R06 | THE SYSTEM SHALL run the database checks of LED-R04 and LED-R05 at commit time, not after each statement, so that the entries of a transaction can be inserted one by one (section 1.3).                                                                                                                                                                                                                                                                                                                            |
| LED-R07 | IF the entries of a transaction do not all share one currency, the transaction's currency differs from its entries' currency, or an entry's currency differs from its account's currency, THEN THE SYSTEM SHALL reject the transaction in the domain, and the database SHALL reject the write.                                                                                                                                                                                                                      |
| LED-R08 | THE SYSTEM SHALL have exactly one settlement system account for each currency of table 1.3 of spec 000, with code `external-settlement:<currency>`, created by a migration and never through the API (the glossary of spec 000, section 1.2).                                                                                                                                                                                                                                                                       |
| LED-R09 | WHEN a deposit, withdrawal or transfer is recorded THE SYSTEM SHALL write the entries of table 1.1, using the settlement account of the movement's currency as the counterparty of every deposit and withdrawal.                                                                                                                                                                                                                                                                                                    |
| LED-R10 | THE SYSTEM SHALL allow the balance of a system account to be below zero.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| LED-R11 | WHEN a transaction is recorded THE SYSTEM SHALL change the cached balance of each customer account it touches by the sum of that account's entries in it, in the same database transaction as the entries.                                                                                                                                                                                                                                                                                                          |
| LED-R12 | IF any write would set the cached balance of a customer account below zero THEN the database SHALL reject it through a constraint, whatever the code that issued it.                                                                                                                                                                                                                                                                                                                                                |
| LED-R13 | THE SYSTEM SHALL keep no cached balance for a system account, enforced by a database constraint, and SHALL compute a system account's balance as the sum of its entries.                                                                                                                                                                                                                                                                                                                                            |
| LED-R14 | WHILE recording a money movement THE SYSTEM SHALL never update a system account's row nor lock it with `FOR UPDATE`, `FOR NO KEY UPDATE` or `FOR SHARE`, so that movements in the same currency never wait for each other on a system account (section 1.3).                                                                                                                                                                                                                                                        |
| LED-R15 | THE SYSTEM SHALL compute system account balances and the sums of the reconciliation with arbitrary precision, so that they never fail with an overflow, including when a system account's balance is below −9223372036854775808.                                                                                                                                                                                                                                                                                    |
| LED-R16 | IF the service's runtime role (LED-R17) or the owner role that runs the migrations (section 1.3) runs UPDATE, DELETE or TRUNCATE on transactions or ledger entries THEN the database SHALL reject the statement and leave the rows unchanged. A superuser can bypass these checks, and so can the owner role through DDL such as `ALTER TABLE ... DISABLE TRIGGER`; only the runtime role (LED-R17) is fully constrained, and the service never connects as the owner or as a superuser.                            |
| LED-R17 | THE SYSTEM SHALL connect to the database at run time with a role that is not a superuser, owns no ledger table and holds only SELECT and INSERT on transactions and ledger entries, so that it cannot disable or drop the database checks of this spec (section 1.3).                                                                                                                                                                                                                                               |
| LED-R18 | WHEN a ledger entry is inserted THE SYSTEM SHALL set its `createdAt` from the clock at the moment of the insert, after the row locks of the movement are held, not from the start of the database transaction, so that the entries of one customer account are ordered by `createdAt` as they committed (ACC-R22).                                                                                                                                                                                                  |
| LED-R19 | WHEN the reconciliation runs THE SYSTEM SHALL report every customer account whose cached balance differs from the sum of its entries, with its id, currency, cached balance, sum of entries and difference, and, for every currency of table 1.3 of spec 000, the global sum: the cached balances of customer accounts plus the sums of entries of system accounts (section 1.5).                                                                                                                                   |
| LED-R20 | WHILE money movements run concurrently THE SYSTEM SHALL compute the reconciliation from one consistent database snapshot without locking any row, so that it never blocks a movement and never reports a discrepancy caused only by a movement in progress (section 1.5).                                                                                                                                                                                                                                           |
| LED-R21 | WHEN `npm run reconcile` is run THE SYSTEM SHALL run the reconciliation against `DATABASE_URL`, print the report as JSON on standard output, and exit with code 0 when there is no discrepancy and every global sum is "0", 1 when there is a discrepancy or a non-zero global sum, and 2 when it cannot run; it SHALL never print credentials (section 1.5).                                                                                                                                                       |
| LED-R22 | WHEN the integration test suite finishes in CI THE SYSTEM SHALL run the reconciliation against the test database and fail the build unless it reports no discrepancy and a global sum of "0" in every currency (section 1.5).                                                                                                                                                                                                                                                                                       |
| LED-R23 | THE SYSTEM SHALL read the maximum amount of a single movement from the configuration variable `MAX_AMOUNT_MINOR`, in minor units, with default "100000000000" when it is unset, and apply it to the amount of every deposit, withdrawal and transfer request, in every currency (section 1.4).                                                                                                                                                                                                                      |
| LED-R24 | IF the amount of a deposit, withdrawal or transfer request is greater than the configured maximum THEN THE SYSTEM SHALL answer 422 with problem type `/problems/validation-error` and an `errors` entry for `amount`, at the validation step of SYS-R31, and write nothing (section 1.4).                                                                                                                                                                                                                           |
| LED-R25 | IF `MAX_AMOUNT_MINOR` is set to a value that is not a string of decimal digits without sign or leading zero from 1 to 9223372036854775807 THEN THE SYSTEM SHALL refuse to start, with an error that names the variable.                                                                                                                                                                                                                                                                                             |
| LED-R26 | IF a deposit or a reversal would make the cached balance of a customer account greater than 9223372036854775807 THEN THE SYSTEM SHALL answer 422 with problem type `/problems/balance-limit-exceeded` (section 1.4), write no transaction, ledger entry, balance change or audit record, and never answer 500 (SYS-R40). Whether the response is stored for idempotent replay is decided in spec 005 (section 4 of spec 000).                                                                                       |
| LED-R27 | THE SYSTEM SHALL do all ledger and balance arithmetic in the domain with `bigint`, exact at the limits of the `bigint` range of PostgreSQL, and never with `number`.                                                                                                                                                                                                                                                                                                                                                |
| LED-R28 | IF the database rejects a ledger write through one of the checks of this spec THEN THE SYSTEM SHALL answer 500 with problem type `/problems/internal-error`, apply none of the movement's effects, and log the rejection at error level with the correlation id, since the domain checks the same rules first and the rejection reveals a defect.                                                                                                                                                                   |
| LED-R29 | IF a transfer would make the cached balance of its destination greater than 9223372036854775807, whoever owns the destination, the sender included, THEN THE SYSTEM SHALL answer exactly as for a destination the sender cannot credit (SYS-R41): 422 with the problem type spec 003 defines and a body that differs only in `requestId`, write no transaction, ledger entry, balance change or audit record, and never answer 500, so that a sender learns nothing about another customer's balance (section 1.4). |

## 3. Acceptance criteria

Unless stated otherwise: customer user C1 owns account A1 (EUR), customer user C2 owns account B1 (EUR), operator user O1 is an operator, balances are set up by deposits from O1, S is the EUR settlement account `external-settlement:EUR`, `MAX_AMOUNT_MINOR` is unset, every deposit, withdrawal, transfer and reversal carries a fresh Idempotency-Key unless the AC names one or says it has none, and "written directly to the database" means SQL run by the service's runtime database role (LED-R17) outside the service's code. In an AC whose When sends no request through the service (it writes directly to the database, runs the reconciliation or runs a script), the balances of the Given, deposits by O1 included, may be set up by a test helper that writes, as the runtime role and in one database transaction, a complete deposit as the service would: the transaction, both ledger entries, the cached balance change and the audit record, so the shared test database still reconciles (LED-R22). The balance of S is asserted only as a change during a test, never as an absolute value, because the integration tests share one database whose ledger cannot be cleared (section 1.5).

### LED-AC01 · The domain builds transactions of the documented shape

- **Level:** unit
- **Covers:** LED-R01, LED-R02, LED-R09
- **Given** customer accounts A1 and B1 in EUR and S, the EUR settlement account
- **When** the domain builds a deposit of 1050n EUR into A1, a withdrawal of 1200n EUR from A1 and a transfer of 300n EUR from A1 to B1
- **Then** the deposit has kind `deposit`, currency EUR and entries +1050n on A1 and −1050n on S; the withdrawal has entries −1200n on A1 and +1200n on S; the transfer has entries −300n on A1 and +300n on B1 and no entry on a system account; every amount is a `bigint`; and the balance changes they produce are +1050n, −1200n and −300n for A1 and +300n for B1

### LED-AC02 · The domain rejects malformed transactions

- **Level:** unit
- **Covers:** LED-R03, LED-R04, LED-R05, LED-R07
- **Given** customer account A1 in EUR, customer account U1 in USD, S and the USD settlement account SU
- **When** the domain is asked to build transactions with: no entries; the single entry +100n on A1; the entries +100n on A1, 0n on B1 and −100n on S; the entries +100n on A1 and −99n on S; the entries +100n EUR on A1 and −100n USD on SU; an entry of +100n USD on A1, which is a EUR account, with −100n USD on SU; and a transaction declared in EUR with the entries +100n USD on U1 and −100n USD on SU
- **Then** each is refused with a typed domain error, in that order: too few entries, too few entries, zero amount, unbalanced, mixed currencies, currency different from the account's, and transaction currency different from its entries'; and no transaction is returned

### LED-AC03 · The database rejects zero amounts and single-entry transactions

- **Level:** integration
- **Covers:** LED-R03, LED-R04
- **Given** A1 with balance "1000" EUR
- **When** these are written directly to the database, each in its own database transaction: a transaction with the entries "100" on A1, "0" on B1 and "-100" on S; a transaction with the single entry "0" on A1; a transaction with the single entry "100" on A1; and a transaction row with no entries
- **Then** the first two are rejected at the insert of the "0" entry, the last two are rejected at commit, no transaction or entry of any of them is stored, and A1 stays "1000" EUR

### LED-AC04 · The balance check runs at commit, not per statement

- **Level:** integration
- **Covers:** LED-R05, LED-R06
- **Given** A1 with balance "1000" EUR
- **When** in one database transaction, written directly to the database, a deposit transaction with entry "100" on A1 is inserted, then entry "-100" on S, then A1's cached balance is raised by "100", then it commits; and in a second database transaction a deposit with entry "100" on A1 and entry "-99" on S is inserted the same way and committed
- **Then** in the first, every statement succeeds although the ledger is unbalanced after the first insert, the commit succeeds and A1 is "1100" EUR; in the second, every insert succeeds, the commit is rejected, neither entry nor the transaction row is stored, and A1 stays "1100" EUR

### LED-AC05 · The database rejects mixed currencies

- **Level:** integration
- **Covers:** LED-R07
- **Given** A1 with "1000" EUR, U1 owned by C1 with "1000" USD, and SU, the USD settlement account
- **When** these are written directly to the database, each in its own database transaction: a transaction with entries "100" EUR on A1 and "-100" USD on SU; a transaction with entries "100" EUR on A1 and "-100" EUR on U1; a EUR transaction with entries "100" USD on A1 and "-100" USD on SU; and a transaction with currency EUR whose entries are "100" USD on U1 and "-100" USD on SU
- **Then** each is rejected, nothing of any of them is stored, A1 stays "1000" EUR and U1 stays "1000" USD

### LED-AC06 · One settlement account per currency, without a cached balance

- **Level:** integration
- **Covers:** LED-R08, LED-R13
- **Given** an empty database with every migration applied
- **When** the system accounts are listed, and then a second system account in EUR with code `external-settlement:EUR`, a system account with cached balance "0" and a customer account without a cached balance are each written directly to the database
- **Then** exactly five system accounts exist, with codes `external-settlement:USD`, `external-settlement:MXN`, `external-settlement:EUR`, `external-settlement:COP` and `external-settlement:JPY`, each in the currency of its code, with no owner and no cached balance; and all three writes are rejected

### LED-AC07 · Deposits and withdrawals settle through the settlement account, which may go negative

- **Level:** integration
- **Covers:** LED-R09, LED-R10, LED-R11, LED-R13
- **Given** A1 with "0" EUR, B1 with "0" EUR, and the balance of S, the sum of its entries, read before the first movement
- **When** O1 deposits "5000" EUR into A1, C1 withdraws "1200" EUR from A1, and C1 transfers "300" EUR from A1 to B1, each with a fresh Idempotency-Key
- **Then** three transactions exist: kind `deposit` with entries "5000" on A1 and "-5000" on S; kind `withdrawal` with entries "-1200" on A1 and "1200" on S; and kind `transfer` with entries "-300" on A1 and "300" on B1; the cached balances are "3500" EUR for A1 and "300" EUR for B1, each equal to the sum of its entries; and the balance of S, the sum of its entries, is "3800" EUR lower than before the first movement, while S still has no cached balance

### LED-AC08 · The database refuses a negative customer balance

- **Level:** integration
- **Covers:** LED-R12, SYS-R12
- **Given** A1 with "1000" EUR
- **When** A1's cached balance is set to "-1" directly in the database; and a withdrawal transaction with entries "-1001" on A1 and "1001" on S, together with lowering A1's cached balance by "1001", is written directly to the database in one database transaction
- **Then** both are rejected, no entry is stored, and A1 stays "1000" EUR

### LED-AC09 · Movements never lock or update a system account

- **Level:** integration
- **Covers:** LED-R14, MOV-R18
- **Given** 50 customer accounts in EUR with "0" EUR, each owned by its own customer; A1, owned by C1, with "1000" EUR; and a separate database session that holds `SELECT ... FOR NO KEY UPDATE` on S's row and records S's row version (`xmin`) and S's balance, the sum of its entries
- **When** O1 deposits "100" EUR into each of the 50 accounts at the same time, each with a fresh Idempotency-Key, and then each customer withdraws "40" EUR from their account at the same time; and C1 transfers "100" EUR from A1 to S; all while that session keeps its lock
- **Then** all 100 movements succeed before the session releases its lock; C1's transfer answers 422 with type `/problems/destination-unavailable` before the session releases its lock, and A1 stays "1000" EUR; S's row version is still the one recorded before the deposits; and S's balance is "3000" EUR lower than the one recorded

### LED-AC10 · System balances and global sums never overflow

- **Level:** integration
- **Covers:** LED-R15
- **Given** the service started with `MAX_AMOUNT_MINOR` "9223372036854775807", and A1 and A2, owned by C1, with "0" EUR
- **When** O1 deposits "9223372036854775807" EUR into A1 and into A2, and the reconciliation runs
- **Then** both deposits succeed; the balance of S, the sum of its entries, is exactly "18446744073709551614" EUR lower than before the first deposit, and is computed without error; and the reconciliation reports no discrepancy and a global EUR sum of "0" without error

### LED-AC11 · Transactions and ledger entries cannot be changed by the runtime or owner role

- **Level:** integration
- **Covers:** LED-R16, SYS-R15
- **Given** a committed deposit T1 of "1000" EUR into A1
- **When** the service's runtime role (LED-R17), and then the owner role that runs the migrations and owns the ledger tables (section 1.3), each run: an UPDATE setting T1's entry on A1 to "2000"; a DELETE of that entry; an UPDATE of T1's kind to `withdrawal`; a DELETE of T1; and a TRUNCATE of the ledger entries and of the transactions
- **Then** every statement fails, and T1 and its two entries are unchanged

### LED-AC12 · The runtime role cannot disable the ledger checks

- **Level:** integration
- **Covers:** LED-R17
- **Given** the service's runtime database role
- **When** that role's attributes and privileges are read from the PostgreSQL catalogue, and the role then tries to disable the triggers of the ledger entries table, drop its balance check, drop the non-negative balance constraint of the accounts table, and set `session_replication_role` to `replica`
- **Then** the role is not a superuser, owns none of the accounts, transactions and ledger entries tables, and holds only SELECT and INSERT on transactions and ledger entries; and each of the four attempts fails with a permission error

### LED-AC13 · Entries are timed when inserted, after the lock

- **Level:** integration
- **Covers:** LED-R18
- **Given** A1 with "0" EUR
- **When** a database session P begins a database transaction and reads its start time; then O1 deposits "100" EUR into A1 through the service, which commits as D1; then P locks A1's row, inserts a balanced deposit of "200" into A1 through the ledger repository, raises A1's cached balance by "200" and commits
- **Then** P's entry on A1 has a `createdAt` later than the entry of D1 on A1, although P's database transaction started before D1's; and C1's history of A1 lists P's entry first and D1's second

### LED-AC14 · Reconciliation reports drift and global sums

- **Level:** integration
- **Covers:** LED-R19
- **Given** A1 with "1000" EUR and B1 with "500" EUR, and, inside a database transaction that the test rolls back at the end, B1's cached balance set directly to "700"
- **When** the reconciliation query runs inside that database transaction
- **Then** it reports exactly one discrepancy: B1, currency EUR, cached balance "700", sum of entries "500", difference "200"; A1 is not listed; the global sums are "200" for EUR and "0" for USD, MXN, COP and JPY; and after the rollback the reconciliation reports no discrepancy

### LED-AC15 · Reconciliation is consistent while money moves

- **Level:** integration
- **Covers:** LED-R20
- **Given** the service started with `DB_POOL_ACQUIRE_TIMEOUT_MS` "10000", `REQUEST_TIMEOUT_MS` "30000" and `SHUTDOWN_TIMEOUT_MS` "30000", so the whole burst can queue for a connection (SEC-R38); and ten customer accounts in EUR, each with "10000" EUR
- **When** 200 transfers of "10" EUR run at the same time, transfer i going from account i mod 10 to account (i + 1) mod 10, each with a fresh Idempotency-Key, while the reconciliation runs 20 times; and then the reconciliation runs once more while a separate database session holds `SELECT ... FOR UPDATE` on the row of one of the ten accounts
- **Then** every one of the 20 reports has no discrepancy and a global sum of "0" in every currency; every transfer succeeds with no 5xx response; and the last reconciliation completes, with no discrepancy, before that session releases its lock

### LED-AC16 · `npm run reconcile` prints JSON and exits by result

- **Level:** integration
- **Covers:** LED-R21
- **Given** a database created for this test with every migration applied, where O1 has deposited "1000" EUR into A1 and "500" EUR into B1
- **When** `npm run reconcile` runs with `DATABASE_URL` pointing to that database; then again after B1's cached balance is raised directly to "501"; then with `DATABASE_URL` pointing to a port where no database listens
- **Then** the first run exits 0 and prints JSON with no discrepancy and global sums of "0" for USD, MXN, EUR, COP and JPY; the second exits 1 and lists B1 with cached balance "501", sum of entries "500" and difference "1"; the third exits 2; and no output of any run contains the database password

### LED-AC17 · The ledger reconciles after every CI test run

- **Level:** ci
- **Covers:** LED-R22
- **Verified by:** CI job `ci`, step `npm run reconcile` with `DATABASE_URL` set to `TEST_DATABASE_URL`, run after `npm run test:integration`
- **Given** the integration suite has run against the test database
- **When** the reconciliation runs against that database
- **Then** it exits 0, with no discrepancy and a global sum of "0" in every currency, or the build fails

### LED-AC18 · The default maximum amount

- **Level:** integration
- **Covers:** LED-R23, LED-R24
- **Given** A1 with "0" EUR, B1 with "0" EUR, and U, an account id that does not exist
- **When** O1 deposits "100000000000" EUR into A1; then, each with a fresh Idempotency-Key, O1 deposits "100000000001" EUR into A1, C1 withdraws "100000000001" EUR from A1, C1 transfers "100000000001" EUR from A1 to B1, and O1 deposits "100000000001" EUR into U
- **Then** the first deposit succeeds and A1 is "100000000000" EUR; each of the other four answers 422 with type `/problems/validation-error` and one `errors` entry, for `amount`; the deposit into U answers 422, not 404; no transaction is added by any of the four; A1 stays "100000000000" EUR and B1 "0" EUR

### LED-AC19 · A configured maximum amount

- **Level:** integration
- **Covers:** LED-R23, LED-R24
- **Given** the service started with `MAX_AMOUNT_MINOR` "500", and C1 owns J1 with "0" JPY
- **When** O1 deposits "500" JPY into J1, then "501" JPY into J1, each with a fresh Idempotency-Key
- **Then** the first succeeds; the second answers 422 with type `/problems/validation-error` and an `errors` entry for `amount`; and J1 is "500" JPY

### LED-AC20 · An invalid maximum amount stops the service from starting

- **Level:** unit
- **Covers:** LED-R23, LED-R25
- **Given** the configuration loader
- **When** it loads `MAX_AMOUNT_MINOR` unset, "500" and "9223372036854775807", and then "0", "-1", "+5", "0500", "1e9", "10.5", "abc", "", " 500" and "9223372036854775808"
- **Then** the first three load as 100000000000n, 500n and 9223372036854775807n; each of the others fails with a configuration error whose message names `MAX_AMOUNT_MINOR`, and the app is not built

### LED-AC21 · A credit that would overflow a balance is refused

- **Level:** integration
- **Covers:** LED-R26, LED-R29, SYS-R40
- **Given** the service started with `MAX_AMOUNT_MINOR` "9223372036854775807"; A1 with "9223372036854775807" EUR, B1 with "10" EUR, and U, an account id that does not exist
- **When** O1 deposits "1" EUR into A1, C2 transfers "1" EUR from B1 to A1, and C2 transfers "1" EUR from B1 to U, each with a fresh Idempotency-Key
- **Then** the deposit answers 422 with type `/problems/balance-limit-exceeded`; both transfers answer 422 with the problem type spec 003 defines for a destination the sender cannot credit, with bodies that differ only in `requestId`; none answers 500; A1 stays "9223372036854775807" EUR and B1 "10" EUR; and none adds a transaction, ledger entry or audit record

### LED-AC22 · Domain arithmetic is exact at the limits

- **Level:** unit
- **Covers:** LED-R26, LED-R27
- **Given** the domain's balance arithmetic
- **When** it credits 1n to a balance of 9223372036854775806n, credits 1n to 9223372036854775807n, credits 9223372036854775807n to 0n, debits 9223372036854775807n from 9223372036854775807n, and is given the `number` 1050 as an amount
- **Then** the results are 9223372036854775807n, a typed balance-limit error, 9223372036854775807n and 0n; and the `number` is refused with a typed error before any arithmetic

### LED-AC23 · A ledger write the database rejects answers 500 and applies nothing

- **Level:** integration
- **Covers:** LED-R28
- **Given** the test app (SYS-R37) with a fault-injection hook that makes the unit of work write the deposit's entry on S as "-99" instead of "-100", and A1 with "1000" EUR
- **When** O1 deposits "100" EUR into A1 with Idempotency-Key k1 and `X-Request-Id: req-led`
- **Then** the answer is 500 with type `/problems/internal-error`; A1 stays "1000" EUR; no transaction, ledger entry, idempotency record or audit record exists for the request; and an error-level log line with correlation id "req-led" records the database rejection with its SQLSTATE

## 4. Error catalogue

Errors shared by every capability are in spec 000. This spec adds:

| Condition                                                                                                               | HTTP | Problem type                         | Stored for idempotent replay |
| ----------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------ | ---------------------------- |
| The amount of a deposit, withdrawal or transfer is greater than `MAX_AMOUNT_MINOR`                                      | 422  | /problems/validation-error           | no                           |
| A deposit or reversal would make a customer account's cached balance greater than 9223372036854775807 (SYS-R40)         | 422  | /problems/balance-limit-exceeded     | yes (spec 005, section 1.3)  |
| A transfer would make its destination's cached balance greater than 9223372036854775807 (LED-R29, SYS-R41)              | 422  | set by spec 003, the same as SYS-R41 | yes (spec 005, section 1.3)  |
| The database rejects a ledger write (unbalanced, too few entries, zero amount, mixed currency, negative cached balance) | 500  | /problems/internal-error             | no                           |
| `MAX_AMOUNT_MINOR` is invalid                                                                                           | n/a  | none: the service does not start     | n/a                          |

## 5. Invariants

- Every transaction has two or more entries, no entry has amount 0, and its entries share one currency and sum to zero (LED-AC03, LED-AC04, LED-AC05).
- Every entry's currency is its account's currency (LED-AC05).
- Exactly one settlement account exists per supported currency (LED-AC06).
- No customer account's cached balance is below zero or above 9223372036854775807 (LED-AC08, LED-AC21).
- System accounts have no cached balance, and no movement updates or locks their rows (LED-AC06, LED-AC09).
- Transactions and ledger entries are never updated or deleted; whether a transaction was reversed follows from the existence of its reversal, never from a change to the original (LED-AC11).
- The reconciliation reports no discrepancy and a global sum of "0" in every currency (LED-AC15, LED-AC17).
- The invariants of spec 000 hold before and after every operation of this spec.

## 6. Out of scope

- The rules of each movement (who may move money, account status, insufficient funds, reversal rules): specs 001, 003 and 004.
- Exchange between currencies (FX): spec 000.
- Repairing a discrepancy found by the reconciliation: it reports, it never writes. A repair is a compensating transaction decided by a person.
- An HTTP endpoint for the reconciliation, and scheduling it in production.
- System accounts other than the settlement accounts, such as fee or suspense accounts.
- Balance snapshots, archiving or partitioning of the ledger.

## 7. Open questions

None. Every question raised while writing this spec was decided by the owner on 2026-10-07 and is stated above as a rule.
