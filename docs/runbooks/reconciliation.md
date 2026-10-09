# Runbook: reconciliation

What to do when the ledger and the cached balances disagree, or another ledger invariant is violated (section 1.5 of [spec 002](../../specs/002-ledger/spec.md), LED-R19 to LED-R22, [ADR-0006](../adr/0006-double-entry-ledger-with-signed-integer-minor-units.md), [ADR-0007](../adr/0007-system-accounts-without-a-cached-balance.md)). `npm run reconcile` checks that every customer account's cached balance equals the sum of its ledger entries, and that every currency sums to zero. It only reads: it is safe to run at any time, against any database, while the service is serving.

## Symptoms and alerts

| Alert                                                                                            | Fires when                                                                                                                          |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `reconcile-drift` ([alerts without an alarm](../observability.md#alerts-without-an-alarm))       | `npm run reconcile` exits 1: the CI step after the integration tests fails the build (LED-R22), or a manual run reports drift       |
| `ledger-write-rejected` ([alerts without an alarm](../observability.md#alerts-without-an-alarm)) | a `request failed` line at `error` has `err.type` `LedgerWriteRejected`: the database refused a write that would break an invariant |

Also run it:

- after an incident that touched the database: a failed migration, a manual fix, a restore from backup;
- whenever a balance looks wrong to a customer or an operator.

## Impact

The ledger entries are the source of truth; a cached balance is derived from them (ADR-0006, ADR-0007). Every movement writes its entries and the balance change in one database transaction, so a drift is a defect, not a race.

- **Drift.** A customer's cached balance, which the API shows and which withdrawals and transfers are checked against, differs from what the ledger says. The customer can spend money they do not have, or not spend money they have.
- **A rejected ledger write.** The database refused a write that would break an invariant (an unbalanced transaction, a negative balance, a change to the append-only ledger), so the request answered 500 and wrote nothing (LED-R28). Money stayed correct; the request did not happen.

## Diagnosis

### Run the reconciliation

```sh
DATABASE_URL=postgres://scf_app:<password>@<host>:<port>/<database> npm run reconcile
```

Locally, `DATABASE_URL` comes from `.env`, so `npm run reconcile` checks the development database, and `make reconcile` checks the stack's. Use the runtime role `scf_app`, as the service does; the command needs no other grant. In AWS it has no task yet ([limitations](../deployment/aws.md#limitations-and-follow-ups)).

It runs one read-only `REPEATABLE READ` transaction: a single snapshot with no row locks, so it blocks no movement and sees every committed movement or none of it. Its statement timeout is 600000 ms (10 minutes, SEC-R48). It never prints the URL or a driver message, which may hold credentials; a failure names only its SQLSTATE.

### Read the report

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

### Find the cause of a drift

1. For each account listed, read its history (`GET /v1/accounts/{id}/entries`, as an operator) and the audit records that name it, to find the last movements before the drift:

   ```sql
   SELECT created_at, action, actor_id, transaction_id, request_id
   FROM audit_records WHERE '<account-id>' = ANY (account_ids) ORDER BY created_at DESC LIMIT 50;
   ```

2. A total that is not "0" in a currency with no discrepancy points at a system account's entries; one that matches a discrepancy is that cached balance.
3. Look for anything that wrote outside the service: a manual `UPDATE accounts`, a restore, a migration. The runtime role can update only `status`, `balance` and `updated_at` of `accounts`, and cannot change or delete transactions or entries (LED-AC11).

### A rejected ledger write

The `request failed` line, at `error`, has `err.type` `LedgerWriteRejected` and carries the SQLSTATE and, when the check has one, the `constraint`; its `reqId` leads to the request. Locally, `docker compose logs --no-log-prefix api-1 api-2 | jq -c 'select(.err.type == "LedgerWriteRejected")'`; in AWS, in `/scf/api`:

```text
filter msg = "request failed" and err.type = "LedgerWriteRejected"
| stats count(*) by constraint, sqlstate
```

## Mitigation

1. Keep the report. Do not edit the ledger: it is append-only, and the database refuses updates and deletes of transactions and entries (SYS-R15, LED-R16).
2. Treat it as an incident and escalate to the service owner. The service has no supported procedure for rewriting a cached balance, and a deposit, withdrawal or reversal changes the entries and the balance together, so it cannot remove a drift.
3. If a customer could overspend because of it, freeze the account until the cause is fixed (`POST /v1/accounts/{id}/freeze`, [compromised account](compromised-account.md#mitigation) shows the call).
4. A rejected ledger write is a defect in the code that built the write: roll back the release that brought it ([deploy and migrate](deploy-and-migrate.md#rollback)) and report it with the constraint.
5. On exit 2, check that `DATABASE_URL` is set and that the database is reachable with that role, then look up the SQLSTATE printed on stderr. `57014` means the statement timeout of 10 minutes ran out on a very large ledger.

## Verification

- `npm run reconcile` exits 0: no discrepancy and every total "0".
- No new `request failed` line with `err.type` `LedgerWriteRejected`.

## Follow-up

- Write up the cause and add a test that reproduces it; the integration tests already end with a reconciliation in CI (LED-AC17).
- A one-off reconcile task in AWS, on the tools stage, run like the migration task ([limitations](../deployment/aws.md#limitations-and-follow-ups)).
