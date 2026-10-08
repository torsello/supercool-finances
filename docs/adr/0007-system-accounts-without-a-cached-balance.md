# ADR-0007: System accounts without a cached balance, never locked

- **Status:** Accepted
- **Date:** 2026-10-07
- **Related specs:** 000-overview, 002-ledger, 003-money-movements, 004-reversals

## Context and problem

In the double-entry ledger (ADR-0006), every deposit and withdrawal in a currency has the settlement account of that currency as its other side (LED-R08, LED-R09). If the settlement account's row were updated or locked by each movement, every deposit and withdrawal in that currency would wait for the one before it: one hot row serializing all traffic. A settlement account's balance also grows without bound below zero as money enters the service (LED-R10), and can pass the `bigint` minimum (LED-R15). Customer accounts, on the other hand, need fast balance reads and a hard guarantee that they never go below zero (SYS-R12). The question is how balances are stored for each kind of account, and which rows a movement may lock.

## Decision drivers

- No hot row: movements in the same currency never wait for each other on a system account (LED-R14).
- System balances never overflow (LED-R15).
- Customer balances are cheap to read and never negative, enforced by the database (LED-R12).
- Cached values stay provably equal to the ledger (SYS-R14, LED-R19).

## Considered options

### Option A: System accounts derive their balance from entries and are never updated or locked; customer accounts keep a cached balance

- **Pros:**
  - Deposits and withdrawals in one currency run in parallel: the only rows they lock are customer accounts.
  - A system account's balance is `SUM(amount)` of its entries computed as `numeric`, with arbitrary precision, so it never overflows (LED-R15, LED-AC10).
  - A database constraint forbids a cached balance on system accounts (LED-R13), so no code path can start updating one.
  - Customer accounts keep a cached `balance` updated in the same transaction as their entries (LED-R11), with `CHECK (balance >= 0)` as a database-level guarantee (LED-R12), and are verified by the reconciliation (LED-R19).
- **Cons:**
  - A system account's balance costs a sum over all its entries, which grows with traffic; acceptable because only operators and the reconciliation read it.
  - Inserting an entry on a system account still takes the `FOR KEY SHARE` lock of the foreign key check on its row, which creates multixacts under load.
  - Two kinds of balance storage to understand and test.

### Option B: Every account, system accounts included, keeps a cached balance updated by each movement

- **Pros:**
  - Uniform model; every balance is one column read.
- **Cons:**
  - Every deposit and withdrawal in a currency updates and row-locks the same settlement row, so they all serialize on it.
  - The settlement balance would overflow `bigint` after enough deposits, and could not carry a `>= 0` check like customer accounts.

### Option C: No cached balances at all; every balance derived from entries

- **Pros:**
  - Nothing to keep in sync; no drift possible.
- **Cons:**
  - Every balance read and every funds check is a sum over a growing table.
  - "Never below zero" can no longer be a simple CHECK constraint, and must be enforced by locking plus a computed sum.

### Option D: Option A without the foreign key from ledger entries to accounts

- **Pros:**
  - No `FOR KEY SHARE` on the settlement row, so no multixacts from concurrent deposits and withdrawals.
- **Cons:**
  - Loses referential integrity on exactly the entries that represent money entering and leaving the service; an entry could name an account that does not exist.
  - Trades a measured cost for an unmeasured risk: the shared lock never blocks another movement (section 1.3 of spec 002).

## Decision

Chosen option: **Option A**, with the foreign key kept. Every deposit and withdrawal touches a settlement account, and locking or updating its row would serialize all of them, so its balance is derived from entries instead, with arbitrary precision so it never overflows. The lock query selects only customer accounts (MOV-R18), so a system account named as a transfer destination is never locked either; that transfer is refused as `/problems/destination-unavailable` (MOV-R15). The shared `FOR KEY SHARE` that the foreign key check takes on the settlement row is accepted, because it never blocks another movement (section 1.3 of spec 002); its cost is measured in the load test (SYS-R20). Customer accounts keep a cached balance with `CHECK (balance >= 0)` for fast reads and a database-level guarantee, verified by reconciliation.

No movement updates a system account's row or takes `FOR UPDATE`, `FOR NO KEY UPDATE` or `FOR SHARE` on it (LED-R14, AGENTS.md section 3), which LED-AC09 proves by holding `FOR NO KEY UPDATE` on the settlement row from another session while 100 movements succeed.

## Consequences

### Positive

- No hot row: throughput of deposits and withdrawals in one currency is not limited by one lock.
- Overflow of a system balance is impossible by construction.
- A negative customer balance is impossible even if the domain check had a defect (LED-AC08).

### Negative / costs

- Reading a settlement balance is an aggregate query; it gets slower as the ledger grows.
- The cached customer balance can drift from the ledger if a defect bypasses the domain; the reconciliation exists to find that, and only a person repairs it with a compensating transaction (spec 002, out of scope).
- Multixact overhead from concurrent `FOR KEY SHARE` locks on settlement rows.

### To monitor

- Load test latency and throughput (SYS-R20) for deposit and withdrawal mixes, and multixact growth in PostgreSQL under that load.
- Reconciliation discrepancies (LED-R19).
- Query plans of the settlement balance sum as the entries table grows.

### Follow-ups

- Phase 05-schema: settlement accounts per currency created by a migration (LED-R08), the constraint forbidding a cached balance on system accounts, and `CHECK (balance >= 0)` on customer accounts.
- Phase 11-e2e: report the measured cost in `docs/performance.md`; if multixacts become a problem, a new ADR revisits the foreign key or introduces balance snapshots.
