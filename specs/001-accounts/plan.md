# 001 · Accounts · Plan

How accounts are created, read, listed, paged and moved through their lifecycle. The shared conventions (where an AC is proven, how tests are named), the movement skeleton, the transaction runner and the error model are in [plan 000](../000-overview/plan.md); this plan only adds what is specific to accounts. The spec wins over this plan.

## 1. Modules and files

| Path                                                           | Phase     | Purpose                                                                                                                                   |
| -------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `migrations/*_accounts.sql`                                    | 05-schema | The `accounts` table of section 2, its constraints, indexes and grants.                                                                   |
| `src/modules/accounts/domain/account.ts`                       | 06-domain | `Account` aggregate: status, cached balance, the lifecycle of section 4 and `canMoveMoney()` (ACC-R11 to ACC-R16, ACC-R19).               |
| `src/modules/accounts/domain/errors.ts`                        | 06-domain | `InvalidStatusTransition`, `AccountBalanceNotZero`, `AccountNotActive`, `NotFound`.                                                       |
| `src/modules/accounts/application/ports.ts`                    | 06-domain | `AccountRepository` (insert, lock for a status change, update status), `AccountQueries` (read, list, history), `AuditLog`, `IdGenerator`. |
| `src/modules/accounts/application/create-account.ts`           | 06-domain | Creates a customer account (ACC-R01, ACC-R02, ACC-R04); 07-idempotency runs it inside the key step when a key is sent (ACC-R03).          |
| `src/modules/accounts/application/change-account-status.ts`    | 06-domain | Freeze, unfreeze and close under the row lock, with the audit record (ACC-R11 to ACC-R17, ACC-R26, ACC-R28, ACC-R29).                     |
| `src/modules/accounts/application/account-queries.ts`          | 06-domain | Read, list and history as query services that bypass the aggregate (ADR-0003), with the visibility rules of ACC-R09, ACC-R10 and ACC-R25. |
| `src/modules/accounts/application/keyset.ts`                   | 06-domain | `Position` (`createdAt` at microseconds as an RFC 3339 string, `id`), the newest-first order and "strictly after" rule of section 1.5.    |
| `src/modules/accounts/adapters/persistence/kysely-accounts.ts` | 06-domain | Kysely implementations of both ports, with the statements of section 3.                                                                   |
| `src/modules/accounts/adapters/http/cursor.ts`                 | 08-api    | Cursor codec: payload and HMAC-SHA256 tag with `CURSOR_SECRET`, compared in constant time (ACC-R23, ACC-R30, ADR-0017).                   |
| `src/modules/accounts/adapters/http/schemas.ts`                | 08-api    | Zod schemas: create body, list and history query strings (`limit`, `cursor`), and the representations of sections 1.3 and 1.4.            |
| `src/modules/accounts/adapters/http/routes.ts`                 | 08-api    | The seven routes of section 1.1 under `/v1`, with `config.roles` for the role check of SYS-R31.                                           |
| `src/modules/accounts/adapters/http/presenters.ts`             | 08-api    | Account (customer and operator views), history entry, page `{items, nextCursor}` and timestamp formatting (section 5).                    |
| `src/modules/accounts/index.ts`                                | 06-domain | The module's public API for the composition root and for the movements module (status rules).                                             |

## 2. Data model changes

Migration `accounts` (05-schema). The table holds customer and system accounts; plan 002 adds the settlement rows and relies on the system-account columns defined here.

```sql
CREATE TABLE accounts (
  id          uuid        PRIMARY KEY,
  kind        text        NOT NULL CHECK (kind IN ('customer', 'system')),
  code        text        UNIQUE,
  owner_id    uuid,
  currency    char(3)     NOT NULL CHECK (currency IN ('USD', 'MXN', 'EUR', 'COP', 'JPY')),
  status      text        CHECK (status IN ('active', 'frozen', 'closed')),
  balance     bigint      CHECK (balance >= 0),                           -- LED-R12
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounts_kind_columns CHECK (
    (kind = 'customer' AND owner_id IS NOT NULL AND status IS NOT NULL AND balance IS NOT NULL AND code IS NULL)
    OR (kind = 'system' AND owner_id IS NULL AND status IS NULL AND balance IS NULL           -- LED-R13
        AND code = 'external-settlement:' || currency)),
  CONSTRAINT accounts_closed_is_empty CHECK (status IS DISTINCT FROM 'closed' OR balance = 0),
  UNIQUE (id, currency)                                                    -- target of the entries' composite foreign key (plan 002)
);
CREATE UNIQUE INDEX accounts_one_system_per_currency ON accounts (currency) WHERE kind = 'system';
CREATE INDEX accounts_owner_list ON accounts (owner_id, created_at DESC, id DESC) WHERE kind = 'customer';
GRANT SELECT, INSERT ON accounts TO scf_app;
GRANT UPDATE (status, balance, updated_at) ON accounts TO scf_app;
```

- `created_at` and `updated_at` default to `now()`, one value per transaction, so they are equal at creation (section 1.3). Every later change sets `updated_at = clock_timestamp()` after the row lock, so it is never earlier than before.
- `accounts_closed_is_empty` backs the invariant "a closed account has balance 0" in the database; the domain refuses the close first (ACC-R16).
- Ids are UUIDv7 from the service's monotonic generator (section 1.3), so newest first by (`created_at`, `id`) is creation order on one replica.

## 3. Operations and their database statements

Each block lists the statements in the order they run. "Skeleton" refers to the steps of section 6.2 of plan 000.

### 3.1 Create an account (`POST /accounts`)

With an `Idempotency-Key` (ACC-R03), skeleton steps 1 to 5 (validation: `currency` is a code of table 1.3 of spec 000 and the body has no other member, ACC-R05), then:

1. Step 6 and 7: none; account creation looks nothing up and locks nothing (section 1.1 of spec 005).
2. Step 8: `INSERT INTO accounts (id, kind, owner_id, currency, status, balance) VALUES ($id, 'customer', $user, $currency, 'active', 0) RETURNING id, currency, status, balance, created_at, updated_at`.
3. Skeleton steps 9 and 10: the key row stores the 201 with `Location: /v1/accounts/<id>`, then `COMMIT`.

Without a key (ACC-R04): validation in process, then the same `INSERT ... RETURNING` as a single statement, in its own implicit transaction. No audit record: the spec audits movements and status changes only.

### 3.2 Read an account (`GET /accounts/{id}`)

The id is parsed as a UUID; if it is not one, the answer is 404 with no query (SYS-R42). Then one statement:

```sql
SELECT id, owner_id, currency, status, balance, created_at, updated_at FROM accounts
WHERE id = $id AND kind = 'customer' [AND owner_id = $user   -- customers only]
```

No row: 404 (ACC-R09, SYS-R38). An operator gets `ownerId` added (ACC-R10).

### 3.3 List own accounts (`GET /accounts`)

Malformed step: the cursor, if present, is decoded and verified (list `accounts`, user = caller), else 400 (ACC-R23). Validation step: `limit` 1 to 100, default 20, and no unknown query parameter, else 422 (ACC-R24, AUT-R09). Then:

```sql
SELECT id, currency, status, balance, created_at, updated_at, <created_at in microseconds> FROM accounts
WHERE owner_id = $user AND kind = 'customer'
  [AND (created_at, id) < ($cursorCreatedAt::timestamptz, $cursorId)]
ORDER BY created_at DESC, id DESC LIMIT $limit + 1
```

The extra row decides whether `nextCursor` is present; it is built from the last item returned. Operators get 403 at the role step (ACC-R27).

### 3.4 List an account's history (`GET /accounts/{id}/entries`)

Malformed step: the cursor is verified for list `entries`, the caller and this path's account id, else 400. Validation step: `limit`. Lookup: the visibility statement of section 3.2 (404 when it returns no row). Then:

```sql
SELECT e.id, e.transaction_id, t.kind, e.amount, e.currency, e.created_at, <e.created_at in microseconds>
FROM ledger_entries e JOIN transactions t ON t.id = e.transaction_id
WHERE e.account_id = $id [AND (e.created_at, e.id) < ($cursorCreatedAt::timestamptz, $cursorId)]
ORDER BY e.created_at DESC, e.id DESC LIMIT $limit + 1
```

The two statements need no transaction: an account's visibility never changes, and entries are ordered as they committed because their `created_at` is taken after the row lock (LED-R18), so a page started before a new entry never skips one (ACC-R22). It is served by the index `(account_id, created_at DESC, id DESC)` of plan 002.

### 3.5 Freeze, unfreeze and close (`POST /accounts/{id}/freeze|unfreeze|close`)

No key: a key sent anyway is not read (SYS-R39). Run with `retry: 'none'` (section 6.1 of plan 000). The id is parsed first (404 if not a UUID).

1. `BEGIN ISOLATION LEVEL READ COMMITTED`
2. `SELECT app.set_lock_timeout($accountLockMs)` (ACC-R28)
3. `SELECT id, owner_id, currency, status, balance, created_at, updated_at FROM accounts WHERE id = $id AND kind = 'customer' FOR UPDATE`. No row: `ROLLBACK`, 404 (SYS-R38). SQLSTATE 55P03: `ROLLBACK`, 503 with `Retry-After: 1` (ACC-R29).
4. The domain decides from the locked row (section 4). Unchanged: `COMMIT` with nothing written, 200 with the account (ACC-R15). Refused: `ROLLBACK`, 409 (ACC-R14, ACC-R16).
5. `UPDATE accounts SET status = $new, updated_at = clock_timestamp() WHERE id = $id RETURNING ...`
6. `INSERT INTO audit_records (id, actor_id, actor_role, action, account_ids, old_status, new_status, request_id) VALUES (..., $action, ARRAY[$id], $old, $new, $requestId)` (ACC-R26)
7. `COMMIT`, then 200 with the account in the operator view.

The lookup and the lock are one statement, because a status change has no step between them; the status and balance used by the decision are read under the lock (ACC-R17).

### 3.6 Effect of the status on movements

`Account.canMoveMoney()` is `status === 'active'`; plans 003 and 004 call it after their row locks. Reversals allow `frozen` (spec 004).

## 4. Domain: the lifecycle

`Account.changeStatus(action)` returns `changed(newStatus)` or `unchanged`, or throws:

| Current  | freeze                    | unfreeze                  | close, balance "0" | close, balance not "0"         |
| -------- | ------------------------- | ------------------------- | ------------------ | ------------------------------ |
| `active` | → `frozen`                | unchanged                 | → `closed`         | `AccountBalanceNotZero`        |
| `frozen` | unchanged                 | → `active`                | → `closed`         | `AccountBalanceNotZero`        |
| `closed` | `InvalidStatusTransition` | `InvalidStatusTransition` | unchanged          | cannot happen (balance is "0") |

## 5. Representations, cursors and timestamps

- **Timestamps.** Every `created_at` is read as an RFC 3339 string with microseconds (`to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`), never through a JavaScript `Date`, which keeps only milliseconds. The API shows it truncated to milliseconds; cursors carry the microsecond string, which SQL casts back to `timestamptz` exactly.
- **Cursor.** `base64url(payload ‖ tag)`, where `payload` is the UTF-8 JSON `{"l": "accounts" | "entries", "u": userId, "a": accountId (entries only), "t": createdAtMicros, "i": id}` and `tag` is the 32-byte HMAC-SHA256 of `payload` with `CURSOR_SECRET`. Decoding fails (400) when the text is not base64url, is shorter than 33 bytes, the tag does not match in constant time, the JSON does not parse into that shape, or `l`, `u` or `a` differ from the request's list, caller and path id (ACC-R23). Every replica with the same secret accepts it (ACC-R30).
- **Pages.** `{"items": [...]}` plus `"nextCursor"` only when there is a next page (ACC-AC27).

## 6. Error mapping

Shared errors are in section 7 of plan 000. This plan's typed errors:

| Typed error                 | When                                                                              | Status | Type                                              | Stored for replay                          |
| --------------------------- | --------------------------------------------------------------------------------- | ------ | ------------------------------------------------- | ------------------------------------------ |
| `ValidationFailed`          | `currency` missing, not a string or not in table 1.3; unknown member; `limit`     | 422    | `/problems/validation-error`                      | no                                         |
| `MalformedRequest` (cursor) | cursor altered, foreign or for another list, user or account                      | 400    | `/problems/malformed-request`                     | n/a                                        |
| `NotFound`                  | unknown id, another customer's account, system account, id not a UUID             | 404    | `/problems/not-found`                             | n/a (reads and status changes take no key) |
| `Forbidden`                 | operator creates or lists; customer changes a status                              | 403    | `/problems/forbidden`                             | no                                         |
| `InvalidStatusTransition`   | freeze or unfreeze a `closed` account                                             | 409    | `/problems/invalid-status-transition`             | n/a                                        |
| `AccountBalanceNotZero`     | close with a balance other than "0"                                               | 409    | `/problems/account-balance-not-zero`              | n/a                                        |
| `AccountLockTimeout`        | status change lock not acquired in `ACCOUNT_LOCK_TIMEOUT_MS`                      | 503    | `/problems/service-unavailable`, `Retry-After: 1` | n/a                                        |
| `AccountNotActive`          | a movement on the caller's side touches a `frozen` or `closed` account (plan 003) | 422    | `/problems/account-not-active`                    | yes                                        |

## 7. Acceptance criteria

Every AC of this spec but one asserts HTTP answers, so it is proven in 08-api; 06-domain proves the use cases and queries under requirement IDs first.

| AC       | Level       | Phase  | Test file                                              |
| -------- | ----------- | ------ | ------------------------------------------------------ |
| ACC-AC01 | integration | 08-api | `test/integration/accounts/create-account.test.ts`     |
| ACC-AC02 | integration | 08-api | `test/integration/accounts/create-account.test.ts`     |
| ACC-AC03 | integration | 08-api | `test/integration/accounts/create-account.test.ts`     |
| ACC-AC04 | integration | 08-api | `test/integration/accounts/create-account.test.ts`     |
| ACC-AC05 | integration | 08-api | `test/integration/accounts/create-account.test.ts`     |
| ACC-AC06 | integration | 08-api | `test/integration/accounts/create-account.test.ts`     |
| ACC-AC07 | integration | 08-api | `test/integration/accounts/read-accounts.test.ts`      |
| ACC-AC08 | integration | 08-api | `test/integration/accounts/read-accounts.test.ts`      |
| ACC-AC09 | integration | 08-api | `test/integration/accounts/read-accounts.test.ts`      |
| ACC-AC10 | integration | 08-api | `test/integration/accounts/read-accounts.test.ts`      |
| ACC-AC11 | integration | 08-api | `test/integration/accounts/status-changes.test.ts`     |
| ACC-AC12 | integration | 08-api | `test/integration/accounts/status-changes.test.ts`     |
| ACC-AC13 | integration | 08-api | `test/integration/accounts/status-changes.test.ts`     |
| ACC-AC14 | integration | 08-api | `test/integration/accounts/status-concurrency.test.ts` |
| ACC-AC15 | integration | 08-api | `test/integration/accounts/status-changes.test.ts`     |
| ACC-AC16 | integration | 08-api | `test/integration/accounts/status-effects.test.ts`     |
| ACC-AC17 | integration | 08-api | `test/integration/accounts/status-effects.test.ts`     |
| ACC-AC18 | integration | 08-api | `test/integration/accounts/history.test.ts`            |
| ACC-AC19 | integration | 08-api | `test/integration/accounts/history.test.ts`            |
| ACC-AC20 | unit        | 08-api | `test/unit/accounts/keyset.test.ts`                    |
| ACC-AC21 | integration | 08-api | `test/integration/accounts/history.test.ts`            |
| ACC-AC22 | integration | 08-api | `test/integration/accounts/read-accounts.test.ts`      |
| ACC-AC23 | integration | 08-api | `test/integration/accounts/status-changes.test.ts`     |
| ACC-AC24 | integration | 08-api | `test/integration/accounts/read-accounts.test.ts`      |
| ACC-AC25 | integration | 08-api | `test/integration/accounts/status-changes.test.ts`     |
| ACC-AC26 | integration | 08-api | `test/integration/accounts/cursor-replicas.test.ts`    |
| ACC-AC27 | integration | 08-api | `test/integration/accounts/history.test.ts`            |

ACC-AC20 is a unit AC about cursors, so it waits for the cursor codec (08-api): it orders the entries with `keyset.ts`, pages them with an in-memory page function that follows the same rule as the SQL of section 3.4, and round-trips every position through a real cursor. ACC-AC19 and ACC-AC27 prove the SQL itself.

## 8. ACs that cannot be tested as written

None open. ACC-AC06 now says no account is created, so the test asserts that the number of accounts is unchanged and none is owned by O1; section 1.5 now says milliseconds are truncated from the stored microseconds (approved by the owner on 2026-10-08).
