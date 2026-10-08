# 002 · Ledger · Plan

How the double-entry ledger is stored, checked by the database, built by the domain, written by the movements and reconciled. The shared conventions, the movement skeleton, the transaction runner and the error model are in [plan 000](../000-overview/plan.md). The spec wins over this plan.

## 1. Modules and files

| Path                                                                   | Phase     | Purpose                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `migrations/*_ledger.sql`                                              | 05-schema | `transactions`, `ledger_entries`, the deferred check trigger, the append-only triggers, indexes and grants (section 2).                                                                                                                                                       |
| `migrations/*_settlement-accounts.sql`                                 | 05-schema | The five settlement accounts of LED-R08, with fixed UUIDv7 ids written in the file.                                                                                                                                                                                           |
| `src/modules/ledger/domain/currency.ts`                                | 06-domain | Currency table (plan 000).                                                                                                                                                                                                                                                    |
| `src/modules/ledger/domain/money.ts`                                   | 06-domain | `Amount` (a `bigint` from 1 to 9223372036854775807), `credit` and `debit` of a cached balance with the limit check, refusing anything that is not a `bigint` (LED-R26, LED-R27).                                                                                              |
| `src/modules/ledger/domain/ledger-transaction.ts`                      | 06-domain | `LedgerTransaction` with its invariants, the builders `deposit`, `withdrawal` and `transfer` of table 1.1, and `balanceChanges()` for customer accounts (LED-R01 to LED-R09). Plan 004 adds `reversalOf`.                                                                     |
| `src/modules/ledger/domain/errors.ts`                                  | 06-domain | `TooFewEntries`, `ZeroAmount`, `MixedCurrencies`, `EntryCurrencyMismatch`, `TransactionCurrencyMismatch`, `Unbalanced`, `BalanceLimitExceeded`, `InvalidAmountType`, and `AlreadyReversed`, whose `cause` is `{sqlstate, constraint}` when the database raised it (plan 004). |
| `src/modules/ledger/application/ports.ts`                              | 06-domain | `LedgerWriter` (append a transaction and apply its balance changes), `BalanceQueries` (sum of an account's entries), `ReconciliationQuery`.                                                                                                                                   |
| `src/modules/ledger/application/reconciliation.ts`                     | 06-domain | Builds the report of section 1.5 and its exit code (LED-R19, LED-R21).                                                                                                                                                                                                        |
| `src/modules/ledger/adapters/persistence/kysely-ledger.ts`             | 06-domain | `LedgerWriter` and `BalanceQueries` with the statements of section 4; the only place that maps SQLSTATE 23505 on `transactions_reversed_transaction_id_key` to `AlreadyReversed` (REV-R06).                                                                                   |
| `src/modules/ledger/adapters/persistence/kysely-reconciliation.ts`     | 06-domain | The reconciliation statements of section 5, run on any executor, so a test can run them inside its own transaction (LED-AC14).                                                                                                                                                |
| `src/modules/ledger/adapters/cli/reconcile.ts`, `scripts/reconcile.ts` | 06-domain | `npm run reconcile`: one REPEATABLE READ, READ ONLY transaction against `DATABASE_URL`, JSON on stdout, exit 0, 1 or 2, no credentials in any output.                                                                                                                         |
| `.github/workflows/ci.yml`                                             | 06-domain | The step `npm run reconcile` with `DATABASE_URL: ${{ env.TEST_DATABASE_URL }}`, right after `npm run test:integration` (LED-R22).                                                                                                                                             |
| `src/platform/config/config.ts`                                        | 08-api    | `MAX_AMOUNT_MINOR` (LED-R23, LED-R25), as a `bigint`.                                                                                                                                                                                                                         |
| `src/modules/movements/adapters/http/schemas.ts`                       | 08-api    | The movement amount schema: the shared amount schema of plan 000 refined with `<= MAX_AMOUNT_MINOR` (LED-R24); reversals have no amount (section 1.4).                                                                                                                        |

## 2. Data model changes

### 2.1 Migration `ledger` (05-schema)

```sql
CREATE TABLE transactions (
  id                      uuid        PRIMARY KEY,
  kind                    text        NOT NULL CHECK (kind IN ('deposit', 'withdrawal', 'transfer', 'reversal')),
  currency                char(3)     NOT NULL CHECK (currency IN ('USD', 'MXN', 'EUR', 'COP', 'JPY')),
  reversed_transaction_id uuid        REFERENCES transactions (id),
  created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),            -- LED-R18
  CONSTRAINT transactions_reversed_transaction_id_key UNIQUE (reversed_transaction_id), -- REV-R05, not deferrable
  CONSTRAINT transactions_reversal_link CHECK ((kind = 'reversal') = (reversed_transaction_id IS NOT NULL)),
  UNIQUE (id, currency)
);

CREATE TABLE ledger_entries (
  id             uuid        PRIMARY KEY,
  transaction_id uuid        NOT NULL,
  account_id     uuid        NOT NULL,
  amount         bigint      NOT NULL CONSTRAINT ledger_entries_amount_not_zero CHECK (amount <> 0), -- LED-R03
  currency       char(3)     NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),                    -- LED-R18
  FOREIGN KEY (transaction_id, currency) REFERENCES transactions (id, currency),    -- entries share the transaction's currency (LED-R07)
  FOREIGN KEY (account_id, currency)     REFERENCES accounts (id, currency)         -- entry currency is its account's (LED-R07)
);
CREATE INDEX ledger_entries_history ON ledger_entries (account_id, created_at DESC, id DESC);
CREATE INDEX ledger_entries_transaction ON ledger_entries (transaction_id);
```

- **Deferred check** (LED-R04 to LED-R06). One PL/pgSQL function, `ledger_check_transaction()`, run by two constraint triggers, `AFTER INSERT ... DEFERRABLE INITIALLY DEFERRED FOR EACH ROW`, one on `transactions` and one on `ledger_entries`. For the row's transaction it reads the count, the `numeric` sum and the number of distinct currencies of its entries, and raises SQLSTATE 23514 with the constraint name `ledger_transaction_min_entries`, `ledger_transaction_balanced` or `ledger_transaction_one_currency`. The trigger on `transactions` catches a transaction row with no entries (LED-AC03). The same function refuses, with constraint name `ledger_transaction_written_once`, a transaction holding an entry whose `xmin` differs from the transaction row's, so entries are never appended to a transaction committed earlier (SYS-R15, LED-R01); this holds because the movement skeleton writes the transaction row and all its entries in one subtransaction, the savepoint `work` (plan 000 section 6.2).
- **Append-only** (LED-R16). `ledger_refuse_change()` raises on `BEFORE UPDATE OR DELETE ... FOR EACH ROW` and `BEFORE TRUNCATE ... FOR EACH STATEMENT`, on both tables. Triggers apply to the owner role too; only DDL by the owner or a superuser can bypass them, as LED-R16 accepts.
- **Grants** (LED-R17). `GRANT SELECT, INSERT ON transactions, ledger_entries TO scf_app`; nothing else. The tables, functions and triggers are owned by `scf_owner`, so `scf_app` cannot alter, disable or drop them, and it cannot set `session_replication_role` (LED-AC12).
- **The foreign key to `accounts`** is kept. Inserting an entry on a settlement account takes `FOR KEY SHARE` on its row, which never conflicts with a movement (section 1.3, ADR-0007).
- The `accounts` table, its `balance >= 0` check (LED-R12), the system-account columns check (LED-R13) and `UNIQUE (id, currency)` are in plan 001.

### 2.2 Migration `settlement-accounts` (05-schema)

Five rows `INSERT INTO accounts (id, kind, code, currency) VALUES (<fixed UUIDv7>, 'system', 'external-settlement:<C>', '<C>')` for USD, MXN, EUR, COP and JPY. The partial unique index `accounts_one_system_per_currency` and the unique `code` of plan 001 keep it one per currency (LED-R08).

## 3. Domain

- **`LedgerTransaction.create({kind, currency, entries, reversedTransactionId?})`**, each entry `{accountId, accountKind, accountCurrency, amount: bigint, currency}`. It checks, in this order, and throws the first failure: fewer than two entries (`TooFewEntries`), an amount of 0n (`ZeroAmount`), more than one currency among the entries (`MixedCurrencies`), an entry whose currency differs from its account's (`EntryCurrencyMismatch`), entries whose currency differs from the transaction's (`TransactionCurrencyMismatch`), and a non-zero sum (`Unbalanced`). That order gives the errors LED-AC02 expects for its seven cases.
- **Builders** (LED-R09). `deposit(account, settlement, amount)` is +A on the account and −A on the settlement account; `withdrawal` the opposite; `transfer(source, destination, amount)` is −A on the source and +A on the destination, never with a system account. `balanceChanges()` returns the change per customer account; system accounts never get one (LED-R11, LED-R13).
- **Arithmetic** (LED-R26, LED-R27). `credit(balance, amount)` throws `BalanceLimitExceeded` above 9223372036854775807n; `debit` returns `balance − amount`, and plans 003 and 004 check funds before calling it. Both throw `InvalidAmountType` when given anything that is not a `bigint`, before any arithmetic. No `number` is used: the lint rule of ADR-0006 forbids conversions in `domain/` and `application/`.

## 4. Writing a transaction

`LedgerWriter.append(tx)` runs step 8 of the movement skeleton (plan 000 section 6.2), on the unit of work's connection, after the row locks:

1. `INSERT INTO transactions (id, kind, currency, reversed_transaction_id) VALUES ($id, $kind, $currency, $reversedId) RETURNING created_at`
2. `INSERT INTO ledger_entries (id, transaction_id, account_id, amount, currency) VALUES (...), (...)`, one row per entry in one statement; `created_at` comes from the column default, after the locks (LED-R18).
3. `UPDATE accounts SET balance = balance + $change, updated_at = clock_timestamp() WHERE id = $id AND kind = 'customer' RETURNING balance`, once per customer account in `balanceChanges()`, in ascending id order. No statement ever updates or locks a system account (LED-R14).

`append` hands the entry rows to the unit of work before step 2 and reports the end of steps 2 and 3 to it; the hook point of the `unit-of-work-faults` seam (entry rewrite and named faults) is in `unit-of-work.ts`, one of the components SYS-AC24 checks, never in this adapter (plan 000 section 8). A 23505 on `transactions_reversed_transaction_id_key` at step 1 is mapped here, once, to `AlreadyReversed` with `cause` `{sqlstate: '23505', constraint: 'transactions_reversed_transaction_id_key'}`; every other database error is left to `sqlstate.ts`. The deferred check runs at `COMMIT`; a rejection there is `LedgerWriteRejected` and answers 500 (LED-R28, plan 000 section 6.3).

A system account's balance is `SELECT COALESCE(SUM(amount), 0)::text FROM ledger_entries WHERE account_id = $id`, a `numeric` sum returned as a string, so it never overflows (LED-R15).

## 5. Reconciliation

`npm run reconcile` (LED-R20, LED-R21), as `scf_app` through `DATABASE_URL`:

1. `BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY` (one snapshot, no row locks)
2. `SELECT app.set_statement_timeout(600000)`, so the runtime role's 5-second limit does not stop a reconciliation of a large ledger (section 1.9 of spec 007)
3. Discrepancies:
   ```sql
   SELECT a.id, a.currency, a.balance::text AS cached, COALESCE(s.total, 0)::text AS entries,
          (a.balance - COALESCE(s.total, 0))::text AS difference
   FROM accounts a
   LEFT JOIN (SELECT account_id, SUM(amount) AS total FROM ledger_entries GROUP BY account_id) s ON s.account_id = a.id
   WHERE a.kind = 'customer' AND a.balance <> COALESCE(s.total, 0)
   ORDER BY a.id
   ```
4. Global sums, one row per currency of table 1.3 in table order:
   ```sql
   SELECT c.currency,
     (COALESCE((SELECT SUM(balance) FROM accounts WHERE kind = 'customer' AND currency = c.currency), 0)
      + COALESCE((SELECT SUM(e.amount) FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
                  WHERE a.kind = 'system' AND a.currency = c.currency), 0))::text AS total
   FROM (VALUES ('USD', 1), ('MXN', 2), ('EUR', 3), ('COP', 4), ('JPY', 5)) AS c (currency, position) ORDER BY c.position
   ```
5. `COMMIT`

Every sum is `numeric`, so it cannot overflow (LED-R15). The report is one line of JSON, `{"discrepancies": [{"accountId", "currency", "cachedBalance", "entriesSum", "difference"}], "totals": [{"currency", "sum"}]}`, every amount a decimal string. Exit 0 when there is no discrepancy and every total is "0", 1 otherwise, 2 when the connection or a statement fails; on exit 2 the script writes a fixed message and the SQLSTATE to stderr, never the URL or the driver's message, which could hold credentials (LED-R21).

The 600000 ms value and the function come from section 1.9 of spec 007.

## 6. Error mapping

Shared errors are in section 7 of plan 000. This plan's typed errors:

| Typed error                                        | When                                                                                                       | Status | Type                                | Stored for replay |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------- | ----------------- |
| `ValidationFailed` (`/amount`)                     | amount of a deposit, withdrawal or transfer above `MAX_AMOUNT_MINOR`                                       | 422    | `/problems/validation-error`        | no                |
| `BalanceLimitExceeded`                             | a deposit or a reversal would raise a cached balance above the limit                                       | 422    | `/problems/balance-limit-exceeded`  | yes               |
| `BalanceLimitExceeded` on a transfer's destination | mapped by plan 003 to `DestinationUnavailable` (LED-R29)                                                   | 422    | `/problems/destination-unavailable` | yes               |
| `LedgerWriteRejected`                              | the database refuses a ledger write (section 2.1), logged at `error` with SQLSTATE, constraint and `reqId` | 500    | `/problems/internal-error`          | no                |
| domain build errors of section 3                   | a use case built a malformed transaction: a defect                                                         | 500    | `/problems/internal-error`          | no                |
| `ConfigError` naming `MAX_AMOUNT_MINOR`            | invalid value at startup (LED-R25)                                                                         | none   | the app is not built                | n/a               |

## 7. Acceptance criteria

| AC       | Level       | Phase        | Test file                                                    |
| -------- | ----------- | ------------ | ------------------------------------------------------------ |
| LED-AC01 | unit        | 06-domain    | `test/unit/ledger/ledger-transaction.test.ts`                |
| LED-AC02 | unit        | 06-domain    | `test/unit/ledger/ledger-transaction.test.ts`                |
| LED-AC03 | integration | 05-schema    | `test/integration/ledger/database-checks.test.ts`            |
| LED-AC04 | integration | 05-schema    | `test/integration/ledger/database-checks.test.ts`            |
| LED-AC05 | integration | 05-schema    | `test/integration/ledger/database-checks.test.ts`            |
| LED-AC06 | integration | 05-schema    | `test/integration/ledger/settlement-accounts.test.ts`        |
| LED-AC07 | integration | 08-api       | `test/integration/ledger/settlement-flows.test.ts`           |
| LED-AC08 | integration | 05-schema    | `test/integration/ledger/database-checks.test.ts`            |
| LED-AC09 | integration | 08-api       | `test/integration/ledger/system-account-locks.test.ts`       |
| LED-AC10 | integration | 08-api       | `test/integration/ledger/overflow.test.ts`                   |
| LED-AC11 | integration | 05-schema    | `test/integration/ledger/append-only.test.ts`                |
| LED-AC12 | integration | 05-schema    | `test/integration/ledger/runtime-role.test.ts`               |
| LED-AC13 | integration | 08-api       | `test/integration/ledger/entry-timestamps.test.ts`           |
| LED-AC14 | integration | 06-domain    | `test/integration/ledger/reconciliation.test.ts`             |
| LED-AC15 | integration | 09-hardening | `test/integration/ledger/reconciliation-concurrency.test.ts` |
| LED-AC16 | integration | 06-domain    | `test/integration/ledger/reconcile-script.test.ts`           |
| LED-AC17 | ci          | 06-domain    | CI step `npm run reconcile` in `.github/workflows/ci.yml`    |
| LED-AC18 | integration | 08-api       | `test/integration/ledger/amount-limits.test.ts`              |
| LED-AC19 | integration | 08-api       | `test/integration/ledger/amount-limits.test.ts`              |
| LED-AC20 | unit        | 08-api       | `test/unit/platform/config.test.ts`                          |
| LED-AC21 | integration | 08-api       | `test/integration/ledger/balance-limit.test.ts`              |
| LED-AC22 | unit        | 06-domain    | `test/unit/ledger/money.test.ts`                             |
| LED-AC23 | integration | 08-api       | `test/integration/ledger/rejected-write.test.ts`             |

Notes:

- The 05-schema ACs (LED-AC03, LED-AC04, LED-AC05, LED-AC08, LED-AC11) and LED-AC14 and LED-AC16 in 06-domain set up their balances with `writeDirectDeposit` (plan 000 section 9), as the preamble of section 3 allows: a complete deposit with its audit record, written as the runtime role in one database transaction.
- LED-AC15 starts the service with the pool acquire, request and shutdown timeouts of spec 007, like MOV-AC14, so it waits for 09-hardening, where the service first reads them.
- LED-AC13 needs a deposit through the service and C1's history, so it waits for 08-api, although its session P writes through the ledger repository of 06-domain.
- LED-AC16 runs `npm run reconcile` as a child process; npm prints its own header first, so the test reads the report from the last line of stdout.
- LED-AC17 is covered once the CI step exists and runs exactly `npm run reconcile`; the step's `env:` sets `DATABASE_URL`, which the traceability check accepts because it is not part of the command.

## 8. ACs that cannot be tested as written

None open. The preamble of section 3 now lets an AC whose When sends no request through the service set up its balances with a complete direct deposit (approved by the owner on 2026-10-08).
