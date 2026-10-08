# ADR-0021: Statement-timeout function for the maintenance scripts

- **Status:** Accepted
- **Date:** 2026-10-08
- **Related specs:** 002-ledger, 005-idempotency, 007-security-ops

## Context and problem

The runtime role `scf_app` starts every session with `statement_timeout` 5 s (SEC-R29, ADR-0019), so a service statement that hangs is cancelled long before the request timeout. Two scripts also connect as the runtime role: the reconciliation (`npm run reconcile`, LED-R21), which sums every ledger entry in one REPEATABLE READ snapshot, and the idempotency cleanup (`npm run idempotency:cleanup`, IDM-R22), which deletes expired key rows in batches and runs every hour in AWS with the runtime role's credentials (DEP-R37). On a large ledger or key table, one of their statements can take longer than 5 s, and the role's limit would cancel it, so the reconciliation would exit 2 and the cleanup would never catch up. The scripts must raise their own limit without a `SET` statement, which pins the connection behind RDS Proxy (SEC-R30, ADR-0019), and without leaving the higher limit on a pooled connection. Section 1.9 of spec 007 fixes the mechanism; the owner approved it on 2026-10-08.

## Decision drivers

- The reconciliation and the cleanup finish on a large database, while the service keeps its 5-second limit.
- No `SET`, `SET LOCAL`, `RESET` or direct `set_config` from any process that may go through RDS Proxy (SEC-R30).
- No setting outlives the database transaction that set it.
- Least privilege: the scripts keep the runtime role's credentials (DEP-R37), never the owner's.
- One mechanism for timeouts set per transaction, already used for lock waits (SEC-R31).

## Considered options

### Option A: A transaction-local SQL function, `app.set_statement_timeout(ms integer)`

The migration `app-functions` creates it next to `app.set_lock_timeout`. It is `SECURITY INVOKER`, refuses any value outside 1 to 3600000 ms (one hour), and runs `set_config('statement_timeout', ms || 'ms', true)`. `EXECUTE` is revoked from `PUBLIC` and granted only to `scf_app`. Each transaction of the reconciliation and of every cleanup batch calls it with 600000 ms (10 minutes) right after `BEGIN`.

- **Pros:**
  - Same shape as the lock-timeout function: a function call does not pin a connection behind RDS Proxy, according to the AWS documentation cited in ADR-0019, and the value ends with the transaction.
  - The scripts keep the runtime role, so they cannot alter or drop anything (ADR-0018).
  - The upper bound of one hour caps a mistaken value, and 600000 ms leaves room for a large ledger while still ending a stuck statement.
- **Cons:**
  - The function is not a privilege boundary: `statement_timeout` can be changed by any session, so the runtime role, which the service also uses, could raise its limit with the function or with `SET LOCAL statement_timeout` alike. The real guards against the service raising its own limit are SEC-R30 with its statement-capture tests (SEC-AC22, SEC-AC23) and the toolchain test that allows `app.set_statement_timeout` only in the two scripts (SEC-R48).
  - It relies on the same documented RDS Proxy behaviour as ADR-0019, which AWS could change.
  - One more SQL function to grant and test.

### Option B: Run the scripts as the owner role, which has no role-level timeout

- **Pros:**
  - No new function, and no limit to raise.
- **Cons:**
  - The scripts would hold credentials that can alter and drop the ledger's checks, against ADR-0018 and DEP-R37.
  - No statement timeout at all: a stuck statement would run until someone kills it.

### Option C: A third database role for the scripts, with its own `ALTER ROLE ... SET statement_timeout`

- **Pros:**
  - The service's role would keep a lower default, but this is no guarantee: a role-level setting is only a session default, which any session can override with `SET` or `set_config`.
- **Cons:**
  - One more role, its grants on every table the scripts read or delete from, and one more secret in AWS (DEP-R31), for two scripts.
  - The specs fix the scripts to the runtime role's `DATABASE_URL` (LED-R21, IDM-R22, DEP-R37).

### Option D: `SET LOCAL statement_timeout` from the scripts

- **Pros:**
  - Standard SQL, no function.
- **Cons:**
  - A `SET` statement pins the connection behind RDS Proxy, which SEC-R30 forbids, and the cleanup runs in AWS behind it.

## Decision

Chosen option: **Option A**, because it reuses the transaction-local function pattern of ADR-0019, so nothing pins a connection behind RDS Proxy and no setting outlives its transaction, the call is a single named function that is easy to find in review, and the scripts keep the runtime role's least privilege. The function exists to avoid pinning and to keep the call reviewable; it is not a privilege boundary, since any session can `SET LOCAL statement_timeout`, and the guards against the service raising its own limit are SEC-R30, its statement-capture tests and the toolchain text check. The function accepts 1 to 3600000 ms, only `scf_app` may execute it, and the reconciliation and the cleanup call it with 600000 ms inside each of their transactions (section 1.9 of spec 007). Running the scripts as the owner role would hand them the power to disable the ledger's checks; a third role adds a secret and grants for two scripts; `SET LOCAL` pins the connection.

## Consequences

### Positive

- The reconciliation and the cleanup finish on large tables, and a statement that is truly stuck still ends after 10 minutes.
- The service's 5-second statement limit stays the default for every session of the runtime role.

### Negative / costs

- The service could raise its own limit, through the function or a `SET`, since it uses the same role; only the statement-capture tests of SEC-R30 and the toolchain text check stop that, not the database.
- The scripts' transactions can hold a snapshot for up to 10 minutes, which delays vacuum on the tables they read.

### To monitor

- Duration of each reconciliation and cleanup run, against the 10-minute limit.
- Review of every call of `app.set_statement_timeout`: only the reconcile and cleanup scripts may make one.
- `DatabaseConnectionsCurrentlySessionPinned` on RDS Proxy, as for ADR-0019.

### Follow-ups

- Phase 05-schema: the function in the migration `app-functions`, with a test of its range, its transaction scope and that `PUBLIC` cannot execute it.
- Phases 06-domain and 07-idempotency: the reconcile and cleanup scripts call it with 600000 ms, asserted from their captured statements.
  - Done for the reconcile script in phase 06-domain on 2026-10-08; the cleanup script follows in 07-idempotency.
- Phase 12-infra: re-check the RDS Proxy pinning behaviour together with ADR-0019's follow-up.
