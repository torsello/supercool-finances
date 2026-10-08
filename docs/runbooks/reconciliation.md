# Runbook: reconciliation

`npm run reconcile` checks that the ledger and the cached balances agree (section 1.5 of [spec 002](../../specs/002-ledger/spec.md), LED-R19 to LED-R22). It only reads: it is safe to run at any time, against any database, while the service is serving.

## When to run it

- After every integration test run: CI runs it against the test database, and a drift fails the build (LED-R22).
- After an incident that touched the database: a failed migration, a manual fix, a restore from backup.
- Whenever a balance looks wrong to a customer or an operator.

## How to run it

```sh
DATABASE_URL=postgres://scf_app:...@host:5432/scf npm run reconcile
```

Locally, `DATABASE_URL` comes from `.env`, so `npm run reconcile` checks the development database. Use the runtime role `scf_app`, as the service does; the command needs no other grant.

It runs one read-only `REPEATABLE READ` transaction: a single snapshot with no row locks, so it blocks no movement and sees every committed movement or none of it. Its statement timeout is 600000 ms (10 minutes, SEC-R48). It never prints the URL or a driver message, which may hold credentials; a failure names only its SQLSTATE.

## Reading the report

The command writes one JSON object on stdout. Every amount is a string of decimal digits in minor units of its currency.

```json
{
  "discrepancies": [
    {
      "accountId": "0192f0a0-...",
      "currency": "EUR",
      "cachedBalance": "1000",
      "entriesSum": "900",
      "difference": "100"
    }
  ],
  "totals": [
    { "currency": "USD", "sum": "0" },
    { "currency": "MXN", "sum": "0" },
    { "currency": "EUR", "sum": "100" },
    { "currency": "COP", "sum": "0" },
    { "currency": "JPY", "sum": "0" }
  ]
}
```

- `discrepancies`: every customer account whose cached `balance` differs from the sum of its ledger entries, with the difference (cached minus entries). Empty when clean.
- `totals`: one entry per supported currency: the cached balances of customer accounts plus the entries of system accounts. Every `sum` is "0" when clean, because every transaction sums to zero. A drift in a cached balance shows here too, as the drift above shows in EUR.

| Exit code | Meaning                                                                                                          |
| --------- | ---------------------------------------------------------------------------------------------------------------- |
| 0         | Clean: no discrepancy and every total "0".                                                                       |
| 1         | Drift: at least one discrepancy or one total that is not "0". The report says where.                             |
| 2         | It could not run: `DATABASE_URL` unset, the database unreachable or the query failed. Stderr names the SQLSTATE. |

## What to do on drift (exit 1)

The ledger entries are the source of truth; a cached balance is derived from them (ADR-0006, ADR-0007). Every movement writes its entries and the balance change in one database transaction, so a drift is a defect, not a race.

1. Keep the report. Do not edit the ledger: it is append-only, and the database refuses updates and deletes of transactions and entries (SYS-R15, LED-R16).
2. For each account listed, read its history (`GET /v1/accounts/{id}/entries`) and the audit records that name it, to find the last movements before the drift.
3. A total that is not "0" in a currency with no discrepancy points at a system account's entries; one that matches a discrepancy is that cached balance.
4. Treat it as an incident and escalate to the service owner. The service has no supported procedure for rewriting a cached balance, and a deposit, withdrawal or reversal changes the entries and the balance together, so it cannot remove a drift.
5. Once the cause is fixed, run `npm run reconcile` again until it exits 0.

## What to do when it cannot run (exit 2)

Check that `DATABASE_URL` is set and that the database is reachable with that role, then look up the SQLSTATE printed on stderr. `57014` means the statement timeout of 10 minutes ran out on a very large ledger.
