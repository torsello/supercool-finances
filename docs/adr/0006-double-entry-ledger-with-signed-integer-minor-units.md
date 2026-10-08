# ADR-0006: Double-entry ledger with signed integer minor units

- **Status:** Accepted
- **Date:** 2026-10-07
- **Related specs:** 000-overview, 001-accounts, 002-ledger, 003-money-movements, 004-reversals

## Context and problem

The service must never lose, create or duplicate money, and must be able to prove it (section 1 of spec 000). Every deposit, withdrawal, transfer and reversal changes balances, and a reviewer, an operator or CI must be able to explain every balance from its history and check that nothing was created or destroyed. Amounts must be exact in every supported currency, including JPY, which has no minor units (table 1.3 of spec 000). The question is how money and its movements are recorded and represented.

## Decision drivers

- Every balance is explainable from an immutable history (SYS-R14, SYS-R15).
- Money is conserved, and that can be checked with SQL (SYS-R10, SYS-R13, LED-R19).
- Exact arithmetic: no rounding, ever (SYS-R06, LED-R27).
- Corrections leave a trace instead of rewriting history (SYS-R15, spec 004).
- The database can enforce the invariants on its own (ADR-0005).

## Considered options

### Option A: Double-entry ledger with one signed amount per entry, in integer minor units

Every movement is one transaction of two or more immutable ledger entries, each with an account and a signed amount; a positive amount credits the account, a negative one debits it, and the entries of a transaction sum to zero (LED-R01, LED-R02, LED-R05). The shapes are those of table 1.1 of spec 002: a deposit is +A on the customer account and −A on the settlement account of its currency; a transfer is −A on the source and +A on the destination.

- **Pros:**
  - Auditable: every balance is the sum of its entries, and every entry belongs to a transaction with a kind, a time and an audit record.
  - Invariants are checkable with SQL: each transaction sums to zero (LED-R05), every currency sums to zero across all accounts (SYS-R13), and each cached balance equals its entries' sum (SYS-R14), all verified by the reconciliation (LED-R19 to LED-R22).
  - One signed column per entry, instead of separate debit and credit columns, makes "sums to zero" a single `SUM(amount) = 0` and avoids entries with both or neither side set.
  - Append-only: corrections are compensating reversals whose entries negate the original's (spec 004, REV-AC03); the original is never edited (SYS-R15, LED-R16).
  - Integer minor units as `bigint` are exact: in the domain as JavaScript `bigint`, in PostgreSQL as `bigint`, in the API as decimal-digit strings with an ISO 4217 code (SYS-R06). The exponent per currency comes from table 1.3 of spec 000 (SYS-R08), so "1050" EUR is 10.50 and "1050" JPY is 1050 yen.
- **Cons:**
  - More rows and more writes per movement than updating a balance.
  - Reading a balance from entries is a sum over a growing table; customer accounts therefore also cache their balance (ADR-0007), which must be kept equal to the entries.
  - Signed amounts need a convention everyone reads the same way (positive credits the account), stated in the glossary of spec 000.
  - `bigint` amounts need care at every boundary: the `pg` driver returns them as strings, and JSON has no `bigint`, so a stray `Number()` or `parseFloat` would silently lose precision. AGENTS.md forbids converting amounts to `number`; the lint rule forbids `parseFloat` today, and phase 06-domain extends it to `Number()`, `Number.parseInt`, `parseInt` and unary `+` in `src/modules/*/domain/**` and `src/modules/*/application/**`. Until then, review is what catches a stray `Number()`. (Update 2026-10-08: phase 06-domain added these lint rules; see eslint.config.js.)

### Option B: A single mutable balance column per account

- **Pros:**
  - Simplest model: one `UPDATE ... SET balance = balance + $1` per account.
  - Fastest reads and fewest writes.
- **Cons:**
  - No audit trail: history must be reconstructed from logs, if at all.
  - No way to prove correctness: there is nothing to reconcile a balance against.
  - Corrections overwrite state, and a defect that creates or destroys money leaves no trace.

### Option C: Decimal or floating-point amounts

- **Pros:**
  - Amounts look like the major units people read (`10.50`).
- **Cons:**
  - Floats cannot represent most decimal fractions exactly and accumulate rounding errors.
  - Exact decimal types exist (PostgreSQL `numeric`, decimal libraries), but JavaScript has no native decimal: amounts would still travel as strings, and every operation would need a library. Integer minor units give exact arithmetic with native `bigint` and one representation in the domain, the database and the API.

## Decision

Chosen option: **Option A**, because a balanced set of immutable entries, one signed amount per entry, makes money auditable and the invariants checkable with SQL. Amounts are `bigint` minor units with a per-currency exponent; floats are never used. Corrections are compensating reversals, never edits. A single mutable balance column is simpler, but has no audit trail and no way to prove correctness.

Where the specs fix the details, this ADR follows them: every amount accepted by the API is 1 to 9223372036854775807 minor units (SYS-R07), and `MAX_AMOUNT_MINOR` caps the amount of deposit, withdrawal and transfer requests (LED-R23), while a reversal carries no amount and is not capped (section 1.4 of spec 002); the direction of a movement comes from its kind, never the sign of the requested amount; entries have amount ≠ 0 and the entry's currency equals its account's (LED-R03, LED-R07); and a credit that would take a cached balance above the `bigint` maximum is refused (LED-R26, LED-R29).

## Consequences

### Positive

- The reconciliation (`npm run reconcile`) can prove after every CI run that no money was created, destroyed or misplaced (LED-R22).
- History for customers (spec 001) and for operators (MOV-R26) is a projection of the ledger, not a separate record.
- A wrong movement is fixed by a reversal that shows both the mistake and its correction.

### Negative / costs

- The ledger grows forever; there is no archiving or snapshotting in this version (out of scope in spec 002).
- Each movement writes at least two entries plus balance updates.
- Every boundary that handles amounts (HTTP, database rows, logs, metrics) must keep them as `bigint` or strings.

### To monitor

- Reconciliation results: any discrepancy or non-zero global sum.
- Lint and review for `number`, `parseFloat` or `Number()` on amounts.
- Size of the ledger entries table and the latency of history reads as it grows.

### Follow-ups

- Phase 05-schema: tables, constraints and the deferred balance trigger of section 1.3 of spec 002.
- Phase 06-domain: `Money`, `Currency` and `LedgerTransaction` with unit tests at the limits (LED-AC22).
  - Done in phase 06-domain on 2026-10-08.
- Phase 06-domain: extend the lint rule so that `Number()`, `Number.parseInt`, `parseInt` and unary `+` are forbidden in `src/modules/*/domain/**` and `src/modules/*/application/**`, with a test that the rule fires.
  - Done in phase 06-domain on 2026-10-08.
- ADR-0007 decides how system and customer account balances are stored.
