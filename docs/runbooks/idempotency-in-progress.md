# Runbook: idempotency in progress

What to do when many requests answer 409 `/problems/request-in-progress` (section 1.1 of [spec 005](../../specs/005-idempotency/spec.md), IDM-R10 to IDM-R12, [ADR-0009](../adr/0009-idempotency-inside-the-movements-transaction.md)). The answer means that another request of the same user with the same `Idempotency-Key` was still running, on any replica, and this one waited `IDEMPOTENCY_WAIT_TIMEOUT_MS` (2000 ms) for it without an outcome.

## Symptoms and alerts

- The alert `idempotency-in-progress` ([observability](../observability.md#alerts-without-an-alarm)): `scf_lock_timeouts_total{lock="idempotency"}` rises faster than usual.
- Clients report 409 with `type` `/problems/request-in-progress` and `Retry-After: 1`.
- It often comes with the alarm `scf-alb-target-response-time-p99`, or with 503s whose `cause` is `AccountLockTimeout` ([timeouts and 503](timeouts-and-503.md)): the first request of each key is slow, so its duplicates wait.

## Impact

None on money. The 409 is answered after the transaction that tried to insert the key row rolled back, so it writes nothing and stores nothing (IDM-R12). The first request goes on and commits or rolls back once. The client retries with the same key after `Retry-After` (section 1.5 of [spec 008](../../specs/008-deployment/spec.md)) and gets the first request's stored response, with `Idempotent-Replayed: true`, or runs the movement if the first one rolled back.

What clients feel is latency: each duplicate waits up to 2 s, then retries after 1 s.

## Diagnosis

1. Read the rate, locally in the Grafana panel "Lock timeouts", or with PromQL run inside the Prometheus container ([dashboards](../observability.md#dashboards)):

   ```text
   sum(rate(scf_lock_timeouts_total{lock="idempotency"}[5m]))
   sum(rate(scf_lock_timeouts_total{lock="account"}[5m]))
   histogram_quantile(0.99, sum by (le) (rate(scf_http_request_duration_seconds_bucket{route=~"/v1/.*"}[5m])))
   ```

   The raw counters of one replica: `docker compose exec -T api-1 wget -qO- http://127.0.0.1:9464/metrics | grep scf_lock_timeouts_total`.

2. Tell the two causes apart:
   - **Slow first requests.** Account lock timeouts or latency rose at the same time. The first request of each key waits on a busy account's row lock, or on a slow database, while holding its key row, so the client's own retries queue behind it. Go to [timeouts and 503](timeouts-and-503.md) or [database](database.md).
   - **Concurrent duplicates from a client.** Latency is normal and only some clients see 409. A client sends the same key again before the first answer arrives: parallel retries, a client timeout shorter than the service's answer, or a double submission.

3. Find the requests and the paths. The 409 is not logged as an error; its `request completed` line has `res.statusCode` 409, and the `incoming request` line with the same `reqId` has the path. Locally:

   ```sh
   docker compose logs --no-log-prefix api-1 api-2 \
     | jq -rc 'select(.res.statusCode == 409) | .reqId' > /tmp/409-ids
   docker compose logs --no-log-prefix api-1 api-2 \
     | grep -F -f /tmp/409-ids | jq -rc 'select(.msg == "incoming request") | [.time, .req.method, .req.url, .req.remoteAddress] | @tsv'
   ```

   In AWS, the same two steps with CloudWatch Logs Insights on `/scf/api`. A 409 is also the answer to `/problems/already-reversed`, `/problems/invalid-status-transition` and `/problems/account-balance-not-zero`, so the paths tell them apart: only movements, reversals and account creation take a key.

   ```text
   filter res.statusCode = 409
   | stats count(*) by bin(1m)
   ```

   ```text
   filter msg = "incoming request" and reqId in ["<reqId>", "<reqId>"]
   | display @timestamp, req.method, req.url, req.remoteAddress
   ```

   Many 409s on one account path point at a hot account; many from one address at one client.

4. Locally, while it happens, the sessions that wait and the one they wait for. A duplicate waits at its key insert; the holder is the first request, and its own `wait_event` shows whether it waits on an account lock:

   ```sql
   SELECT pid, pg_blocking_pids(pid) AS blocked_by, wait_event_type, wait_event,
          now() - xact_start AS open_for, left(query, 80) AS query
   FROM pg_stat_activity
   WHERE datname = current_database() AND state <> 'idle'
   ORDER BY xact_start;
   ```

   An uncommitted key row is invisible to other sessions, so `idempotency_keys` shows nothing of the requests in progress.

## Mitigation

1. **Slow first requests.** Treat the slowness: [timeouts and 503](timeouts-and-503.md) for lock contention and the pool, [database](database.md) for the database. The 409s stop with it.
2. **A client sending duplicates.** Tell its owner: a client must wait for an answer, or for `Retry-After`, before resending a key, and must not send the same key from several workers at once. The per-user rate limit bounds what one user can send ([rate limits](rate-limits.md)).
3. Do not raise `IDEMPOTENCY_WAIT_TIMEOUT_MS` to hide it. It ends at 4999 ms, below `statement_timeout`, and every millisecond is counted three times in the budget of `REQUEST_TIMEOUT_MS` ([timeouts and 503](timeouts-and-503.md#changing-a-timeout)).
4. Nothing needs repair: a 409 leaves no row, no entry and no balance change.

## Verification

- `rate(scf_lock_timeouts_total{lock="idempotency"}[5m])` is back to its usual level.
- The client's retries of the affected keys answered 201, or the stored answer with `Idempotent-Replayed: true`; the nginx access log (`docker compose logs nginx`) or `/scf/api` shows their status.

## Follow-up

- The alert `idempotency-in-progress` is a documented signal, not a deployed alarm; in AWS it needs the metrics scraped first ([observability](../observability.md#metrics)).
- If one hot account causes it, record the pattern: movements on one account are serialized by its row lock by design (ADR-0008).
