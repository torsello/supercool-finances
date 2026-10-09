# Runbook: rate limits

What to do when clients are refused for sending too much, or when the limits stop applying (section 1.6 of [spec 007](../../specs/007-security-ops/spec.md), [ADR-0013](../adr/0013-rate-limiting-at-the-edge-and-in-redis.md)). There are two limits, and each is answered by a different layer.

| Limit    | Where                                     | Answer                                                                                       | Default                                                                                |
| -------- | ----------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Per IP   | nginx locally (SEC-R01)                   | 429 `/problems/rate-limited`, `Retry-After: 1`; the request never reaches a replica          | `RATE_LIMIT_IP_RPS` 500 per second with a burst of `RATE_LIMIT_IP_BURST` 1000          |
| Per IP   | AWS WAF in AWS (SEC-R45)                  | 429 from WAF, `Retry-After: 60`, JSON body without `requestId`; never reaches the targets    | 60 × `RATE_LIMIT_IP_RPS` = 30000 requests per IP per 1-minute window, no burst         |
| Per user | every replica, counted in Redis (SEC-R03) | 429 `/problems/rate-limited`, `Retry-After` the whole seconds left in the window, at least 1 | `RATE_LIMIT_USER_MAX` 300 requests per `RATE_LIMIT_USER_WINDOW_S` 10 s window per user |

Neither answer is stored for idempotent replay, and neither changes anything: the request can be sent again, with the same `Idempotency-Key`, once `Retry-After` has passed. The automatic retry policy of section 1.5 of [spec 008](../../specs/008-deployment/spec.md) does not retry a 429; slowing down is the client's decision.

## A client gets 429

1. Find the response's `X-Request-Id`, which is also the body's `requestId`.
2. Look it up in nginx's access log (`docker compose logs nginx`), one JSON line per request with `requestId`, `status`, `upstream` and `upstreamStatus`:
   - `status` 429 with no `upstream`: the per-IP limit at nginx. The client's address is `remoteAddr`, the TCP peer (SEC-R02), never a header it sent.
   - `upstreamStatus` 429: a replica answered it, so the per-user limit. The replica's `request completed` line with the same `reqId` has `res.statusCode` 429, and `scf_rate_limited_total` rises.
3. Decide whether the client is misbehaving or the limit is too low for a legitimate use. A well-behaved client waits at least `Retry-After` before sending more.

In AWS, a per-IP block is a 429 from WAF with `Retry-After: 60` and a JSON body of type `/problems/rate-limited` but no `requestId` (section 1.6 of spec 007); a 403 from WAF is a managed rule group, not the rate. Both are logged in the log group `aws-waf-logs-scf` with the rule `per-ip-rate-limit` and the client IP. The alarm `scf-waf-blocked-requests` fires above 1000 blocked requests in 5 minutes; it counts the managed rule groups' blocks too, so check the rule in the log before blaming the rate. A per-user 429 shows in the log group `/scf/api` as above.

## Changing a limit

Configuration is read only at startup, so a change takes effect when the process restarts (section 6 of spec 007).

- Locally, per IP: set `RATE_LIMIT_IP_RPS` or `RATE_LIMIT_IP_BURST` in the shell or `.env` and run `docker compose up -d nginx`; `compose.yaml` interpolates them and the nginx image renders its template from them at start.
- Locally, per user: set `RATE_LIMIT_USER_MAX` (1 to 1000000) or `RATE_LIMIT_USER_WINDOW_S` (1 to 3600) the same way and run `docker compose up -d api-1 api-2`. An invalid value stops the replica at startup with an error naming the variable (SEC-R40).
- In AWS, per IP: change the Terraform variable `rate_limit_ip_rps` and apply; the WAF rule's limit is 60 times it.
- In AWS, per user: the service's task definition does not set `RATE_LIMIT_USER_MAX` or `RATE_LIMIT_USER_WINDOW_S`, so the defaults apply. Changing them is a change to the `api` container of the `service` module, deployed like any release ([deploy and migrate](deploy-and-migrate.md)).

## The per-user limit stopped applying (Redis down)

Redis holds only the per-user counters (SEC-R07). When it is unreachable or does not answer within `REDIS_COMMAND_TIMEOUT_MS` (100 ms), the limit fails open: every request is served as if under the limit, and money, idempotency and readiness are unaffected (SEC-R06).

- Each replica logs one `warn` line, `Redis unavailable: the per-user rate limit lets requests through`, with the error `code`, and one `info` line, `Redis available: the per-user rate limit applies again`, when Redis answers again. No line per request.
- `scf_rate_limit_store_errors_total` rises with every check that failed open.
- The per-IP limit still applies, at nginx or WAF.

Locally, check `docker compose ps redis` and start it again with `docker compose up -d redis`; the replicas reconnect on their own. In AWS, ElastiCache promotes the replica on a node failure, and the alarm `scf-cache-memory` fires when a node is above 80% memory; see "Loss of Redis" in [docs/deployment/aws.md](../deployment/aws.md#loss-of-redis). Nothing needs repair afterwards: the counters are short-lived and start again from zero.

## Metrics

On `METRICS_PORT` (9464) of each replica, never routed or published (SEC-R43). Locally: `docker compose exec api-1 wget -qO- http://127.0.0.1:9464/metrics`.

| Metric                              | Meaning                                                 |
| ----------------------------------- | ------------------------------------------------------- |
| `scf_rate_limited_total`            | Requests answered 429 by this replica's per-user limit. |
| `scf_rate_limit_store_errors_total` | Per-user checks that failed open because of Redis.      |
