# Runbook: idempotency cleanup

`npm run idempotency:cleanup` deletes the idempotency keys whose TTL has passed (IDM-R22, section 1.4 of [spec 005](../../specs/005-idempotency/spec.md)). It only bounds the size of the `idempotency_keys` table: a key expires at its TTL whether or not the cleanup ran, because a request with an expired key replaces the row and runs as a new request (IDM-R21).

## When it runs

- In AWS, every hour, as a scheduled task (DEP-R37, phase 12-infra).
- Locally, by hand, when the development database has grown, or to check the command after a change.
- Never inside the service: replicas never race on it.

It is safe to run at any time while the service is serving. It deletes only expired rows, and skips a row that a request in progress holds (`FOR UPDATE SKIP LOCKED`) instead of waiting for it; that row goes on the next run.

## How to run it

```sh
DATABASE_URL=postgres://scf_app:...@host:5432/scf npm run idempotency:cleanup
```

Locally, `DATABASE_URL` comes from `.env`, so the command cleans the development database. Use the runtime role `scf_app`, as the service does.

It deletes in batches of 1000 rows, oldest expiry first, each batch in its own database transaction, until a batch deletes fewer than 1000. Each transaction raises its statement timeout to 600000 ms (10 minutes, SEC-R48). It waits at most 10 seconds to connect.

## Reading the result

It writes one line of JSON on stdout with the number of rows deleted:

```json
{ "deleted": 1234 }
```

| Exit code | Meaning                                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0         | Done: every expired row not held by a request in progress was deleted. `deleted` may be 0.                                                             |
| 2         | It could not run: `DATABASE_URL` unset, the database unreachable within 10 seconds, or a statement failed. Stderr names the SQLSTATE, if there is one. |

It never prints the URL or a driver message, which may hold credentials.

## What to do on exit 2

1. Read the SQLSTATE on stderr. None, with `DATABASE_URL` set: the database did not answer; check that it is up and reachable from where the command runs.
2. `57014`: a batch took longer than 10 minutes, which means the table is far larger than an hour of traffic or the database is overloaded. Check the database's load, then run the command again; each finished batch stays deleted.
3. `42501`: the role lacks a grant. The command needs `SELECT` and `DELETE` on `idempotency_keys` and `EXECUTE` on `app.set_statement_timeout`, which the migrations grant to `scf_app`; check that the URL uses that role and that every migration is applied.
4. Any failure leaves the table as it was before the failed batch. Nothing is lost: an expired key that stays in the table is replaced by the next request that uses it.
