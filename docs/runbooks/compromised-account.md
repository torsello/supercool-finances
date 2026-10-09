# Runbook: compromised account

What to do when a customer's credentials or tokens may be in someone else's hands: freeze, investigate, reverse, then restore ([spec 001](../../specs/001-accounts/spec.md) section 1.2, [spec 004](../../specs/004-reversals/spec.md), [ADR-0012](../adr/0012-simulated-authentication-with-jwt-and-two-roles.md)). Every step below goes through the API as an operator, so each change is audited with the operator's id and the request's correlation id (SYS-R23, ACC-R26).

The examples use `BASE` (the API's base URL, `http://localhost:8080` locally) and `OPERATOR_TOKEN`, an operator's bearer token. Locally, `eval "$(make demo-env)"` sets one; in AWS it comes from the token issuer, since the API issues none (AUT-R15).

## Symptoms and alerts

No alarm detects a compromised account: the service cannot tell a thief's valid token from the customer's. The alert `compromised-account` ([observability](../observability.md#alerts-without-an-alarm)) is a report: the customer disputes movements, support sees an unusual pattern, or the token issuer reports a breach.

## Impact

Whoever holds a valid token for the customer acts as the customer until the token expires, at most 15 minutes after it was issued (AUT-R05), and for as long as the issuer keeps issuing tokens for that user. They can:

- read the customer's accounts and histories;
- withdraw: the money leaves through the settlement account, outside the service;
- transfer to any customer's active account in the same currency, their own accomplice's included;
- open new, empty accounts.

They cannot deposit, reverse, freeze or unfreeze: those are operator operations (AUT-R10). No service-side revocation of one user's tokens exists: tokens are verified from the token and the configuration alone (AUT-R21).

## Diagnosis

1. **The customer's accounts.** Get their ids from the customer or support. An operator cannot list a customer's accounts through the API (ACC-R27). With database access (locally: `docker compose exec postgres psql -U scf_app supercool_dev`), by the customer's user id, the token's `sub`:

   ```sql
   SELECT id, currency, status, balance, created_at FROM accounts
   WHERE kind = 'customer' AND owner_id = '<user-id>' ORDER BY created_at;
   ```

2. **What moved.** Each account's history, newest first; follow `nextCursor` with `?cursor=` for older pages:

   ```sh
   curl -s "$BASE/v1/accounts/<account-id>/entries?limit=100" -H "Authorization: Bearer $OPERATOR_TOKEN"
   ```

   Each entry names its `transactionId` and `kind`. For each suspicious one, the whole transaction, with the destination account of a transfer, which an operator sees:

   ```sh
   curl -s "$BASE/v1/transactions/<transaction-id>" -H "Authorization: Bearer $OPERATOR_TOKEN"
   curl -s "$BASE/v1/accounts/<destination-account-id>" -H "Authorization: Bearer $OPERATOR_TOKEN"   # ownerId, status, balance
   ```

3. **Who did it, and from where.** The audit records name the actor and the correlation id of every movement and status change, also for accounts the customer does not own:

   ```sql
   SELECT created_at, action, actor_id, actor_role, account_ids, transaction_id, request_id
   FROM audit_records
   WHERE actor_id = '<user-id>' OR '<account-id>' = ANY (account_ids)
   ORDER BY created_at;
   ```

   The `request_id` leads to the `incoming request` log line, with the client address and the `user-agent` header, never the token (SEC-R22). In `/scf/api` with CloudWatch Logs Insights, or locally with `docker compose logs --no-log-prefix api-1 api-2 nginx | grep <request-id>`:

   ```text
   filter reqId in ["<request-id>", "<request-id>"] and msg = "incoming request"
   | display @timestamp, req.method, req.url, req.remoteAddress, `req.headers.user-agent`
   ```

   Requests from an address or client the customer does not recognize mark the start of the compromise. Every request from that address, by path:

   ```text
   filter msg = "incoming request" and req.remoteAddress = "<address>"
   | stats count(*) by req.method, req.url
   ```

4. **How it happened.** A leaked token or a compromised login at the issuer is the issuer's to investigate. If `JWT_SECRET` itself may have leaked, every user is exposed, not one: go to [secret rotation](secret-rotation.md#jwt_secret) at once.

## Mitigation

1. **Freeze each of the customer's accounts.** A frozen account can neither send nor receive money (ACC-R19); a movement already holding the row lock finishes first, and every later one is refused with 422 `/problems/account-not-active` (ACC-R17):

   ```sh
   curl -s -X POST "$BASE/v1/accounts/<account-id>/freeze" -H "Authorization: Bearer $OPERATOR_TOKEN"
   ```

   Freezing a frozen account answers 200 and changes nothing (ACC-R15), so repeating it is safe.

2. **Stop new tokens.** Ask the token issuer to block the user and end their sessions. Tokens already issued expire within 15 minutes; until then they can still read the frozen accounts and open new, empty ones, but move nothing out of a frozen account. If the secret leaked, rotate `JWT_SECRET`, which invalidates every token ([secret rotation](secret-rotation.md)).

3. **Freeze the destinations, when policy allows.** Money transferred to another customer can still move on from there. Freezing that account, after the decision of whoever owns fraud cases, keeps the money for the reversal: a reversal applies to a frozen account and leaves it frozen (REV-R09).

4. **Reverse each fraudulent transfer.** One reversal per transaction, with its own `Idempotency-Key` and a reason that names the case; the reason is audited but never returned or logged (REV-R16):

   ```sh
   curl -s -X POST "$BASE/v1/transactions/<transaction-id>/reversals" \
     -H "Authorization: Bearer $OPERATOR_TOKEN" -H 'Content-Type: application/json' \
     -H 'Idempotency-Key: case-<case-id>-<transaction-id>' \
     -d '{"reason": "Unauthorized transfer, case <case-id>"}'
   ```

   | Answer                                          | Meaning and next step                                                                                                                                                  |
   | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | 201                                             | Reversed: the entries are negated on the same accounts.                                                                                                                |
   | 409 `/problems/already-reversed`                | Someone reversed it already. Read it with `GET /v1/transactions/{id}`.                                                                                                 |
   | 422 `/problems/insufficient-funds-for-reversal` | The destination no longer holds the amount (REV-R08). Nothing was written. Freeze it if not done and escalate: the service cannot take money a customer does not have. |
   | 422 `/problems/account-not-active`              | An account of the transaction is `closed` (REV-R10). Escalate.                                                                                                         |
   | 409 `/problems/request-in-progress` or 503      | Retry with the same key after `Retry-After`.                                                                                                                           |

   Reverse a withdrawal only when the payout was stopped or recovered outside the service: the reversal credits the customer again, while the money that left stays gone.

5. **Restore.** Once the customer controls their credentials again and the case allows it, unfreeze each account; the unfreeze is audited like the freeze:

   ```sh
   curl -s -X POST "$BASE/v1/accounts/<account-id>/unfreeze" -H "Authorization: Bearer $OPERATOR_TOKEN"
   ```

## Verification

- `GET /v1/accounts/{id}` shows each account `frozen` while the case is open, and `active` after the restore.
- The history of each account shows a `reversal` entry for each fraudulent transfer, and the balances are what the customer had before the compromise, less any withdrawal that was not recovered.
- The audit records show the `freeze`, each `reversal` and the `unfreeze`, with the operator's id:

  ```sql
  SELECT created_at, action, actor_id, account_ids, transaction_id, reversed_transaction_id, old_status, new_status
  FROM audit_records WHERE '<account-id>' = ANY (account_ids) AND actor_role = 'operator' ORDER BY created_at;
  ```

- `npm run reconcile` exits 0 ([reconciliation](reconciliation.md)); a reversal moves the entries and the balances together, so it never creates drift.

## Follow-up

- Write the case up: the window of the compromise, the addresses, every transaction and its reversal, and what was not recovered.
- The service has no operator endpoint to list a customer's accounts or read the audit records, and in AWS no operator host reaches the database ([limitations](../deployment/aws.md#limitations-and-follow-ups)), so steps 1 and 3 of the diagnosis need the customer's account ids or a one-off task. Both are candidates for a spec change.
- Revoking one user's tokens before they expire would need state shared by every replica, such as a denylist in PostgreSQL; section 6 of spec 006 leaves token revocation out.
