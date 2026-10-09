# Runbook: rate limits

What to do when clients are refused for sending too much, when AWS WAF blocks many requests, or when the per-user limit stops applying because Redis is down (section 1.6 of [spec 007](../../specs/007-security-ops/spec.md), [ADR-0013](../adr/0013-rate-limiting-at-the-edge-and-in-redis.md)). There are two limits, and each is answered by a different layer.

| Limit    | Where                                     | Answer                                                                                       | Default                                                                                |
| -------- | ----------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Per IP   | nginx locally (SEC-R01)                   | 429 `/problems/rate-limited`, `Retry-After: 1`; the request never reaches a replica          | `RATE_LIMIT_IP_RPS` 500 per second with a burst of `RATE_LIMIT_IP_BURST` 1000          |
| Per IP   | AWS WAF in AWS (SEC-R45)                  | 429 from WAF, `Retry-After: 60`, JSON body without `requestId`; never reaches the targets    | 60 × `RATE_LIMIT_IP_RPS` = 30000 requests per IP per 1-minute window, no burst         |
| Per user | every replica, counted in Redis (SEC-R03) | 429 `/problems/rate-limited`, `Retry-After` the whole seconds left in the window, at least 1 | `RATE_LIMIT_USER_MAX` 300 requests per `RATE_LIMIT_USER_WINDOW_S` 10 s window per user |

## Symptoms and alerts

| Alert                                                                                        | Fires when                                                                                                                      |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `scf-waf-blocked-requests` ([alarms](../observability.md#alarms))                            | AWS WAF blocked more than 1000 requests in 5 minutes, by the per-IP rate rule or by a managed rule group                        |
| `redis-unavailable` ([alerts without an alarm](../observability.md#alerts-without-an-alarm)) | `scf_rate_limit_store_errors_total` rises, or a replica logs `Redis unavailable: the per-user rate limit lets requests through` |

Clients report 429 `/problems/rate-limited`, or a 403 from WAF.

## Impact

- **A 429.** The request changed nothing and is not stored for idempotent replay: it can be sent again, with the same `Idempotency-Key`, once `Retry-After` has passed. The automatic retry policy of section 1.5 of [spec 008](../../specs/008-deployment/spec.md) does not retry a 429; slowing down is the client's decision.
- **A 403 from WAF.** A managed rule group blocked the request as malicious, or its body is above 8 KB; the service never saw it.
- **Redis down.** Redis holds only the per-user counters (SEC-R07). When it is unreachable or does not answer within `REDIS_COMMAND_TIMEOUT_MS` (100 ms), the limit fails open: every request is served as if under the limit, and money, idempotency and readiness are unaffected (SEC-R06). Each request waits at most 100 ms for the check. The per-IP limit still applies, at nginx or WAF, so the exposure is one user sending more than 300 requests per 10 s from addresses below the per-IP limit.

## Diagnosis

### A client gets 429

1. Find the response's `X-Request-Id`, which is also the body's `requestId`.
2. Look it up in nginx's access log (`docker compose logs nginx`), one JSON line per request with `requestId`, `status`, `upstream` and `upstreamStatus`:
   - `status` 429 with no `upstream`: the per-IP limit at nginx. The client's address is `remoteAddr`, the TCP peer (SEC-R02), never a header it sent.
   - `upstreamStatus` 429: a replica answered it, so the per-user limit. The replica's `request completed` line with the same `reqId` has `res.statusCode` 429, and `scf_rate_limited_total` rises.
3. Decide whether the client is misbehaving or the limit is too low for a legitimate use. A well-behaved client waits at least `Retry-After` before sending more.

In AWS, a per-IP block is a 429 from WAF with `Retry-After: 60` and a JSON body of type `/problems/rate-limited` but no `requestId` (section 1.6 of spec 007). A per-user 429 shows in the log group `/scf/api` as above.

### `scf-waf-blocked-requests`

The alarm counts every block, the managed rule groups' 403s with the rate rule's 429s, so find the rule first. WAF logs each request to the log group `aws-waf-logs-scf`, with the `authorization`, `cookie` and `idempotency-key` headers redacted. With CloudWatch Logs Insights:

```text
filter action = "BLOCK"
| stats count(*) by terminatingRuleId, httpRequest.clientIp
| sort count(*) desc
| limit 20
```

- `terminatingRuleId` `per-ip-rate-limit`: one or a few addresses sent above 30000 requests per minute.
- `aws-common-rule-set` or `aws-known-bad-inputs`, the managed rule groups `AWSManagedRulesCommonRuleSet` and `AWSManagedRulesKnownBadInputsRuleSet`: requests WAF took for attacks, or bodies above 8 KB. `ruleGroupList` names the rule inside the group.

### Redis down

- Each replica logs one `warn` line, `Redis unavailable: the per-user rate limit lets requests through`, with the error `code`, and one `info` line, `Redis available: the per-user rate limit applies again`, when Redis answers again. No line per request.
- `scf_rate_limit_store_errors_total` rises with every check that failed open:

  ```sh
  docker compose exec -T api-1 wget -qO- http://127.0.0.1:9464/metrics | grep -E '^scf_rate_limit'
  ```

- Locally, `docker compose ps redis`. In AWS, the replication group's events and status:

  ```sh
  aws elasticache describe-events --source-type replication-group --source-identifier scf --duration 60
  aws elasticache describe-replication-groups --replication-group-id scf --query 'ReplicationGroups[0].{status: Status, nodes: NodeGroups[0].NodeGroupMembers[].{id: CacheClusterId, role: CurrentRole}}'
  ```

## Mitigation

### Too many 429s for a legitimate client

Configuration is read only at startup, so a change takes effect when the process restarts (section 6 of spec 007).

- Locally, per IP: set `RATE_LIMIT_IP_RPS` or `RATE_LIMIT_IP_BURST` in the shell or `.env` and run `docker compose up -d nginx`; `compose.yaml` interpolates them and the nginx image renders its template from them at start.
- Locally, per user: set `RATE_LIMIT_USER_MAX` (1 to 1000000) or `RATE_LIMIT_USER_WINDOW_S` (1 to 3600) the same way and run `docker compose up -d api-1 api-2`. An invalid value stops the replica at startup with an error naming the variable (SEC-R40).
- In AWS, per IP: change the Terraform variable `rate_limit_ip_rps` and apply; the WAF rule's limit is 60 times it.
- In AWS, per user: the service's task definition does not set `RATE_LIMIT_USER_MAX` or `RATE_LIMIT_USER_WINDOW_S`, so the defaults apply. Changing them is a change to the `api` container of the `service` module, deployed like any release ([deploy and migrate](deploy-and-migrate.md)).

### `scf-waf-blocked-requests`

- The rate rule against a few addresses: WAF is doing its job. If one address is a legitimate partner behind a shared egress, raise `rate_limit_ip_rps` as above; otherwise nothing is needed.
- A managed rule group against legitimate traffic: confirm with the request's details in the log, then report it. Excluding a rule is a Terraform change to the `edge` module and weakens the edge, so it needs a review.
- An attack large enough to hurt the targets despite WAF shows as [capacity](capacity.md) alarms too.

### Redis down

1. Locally, start it again with `docker compose up -d redis`; the replicas reconnect on their own.
2. In AWS, ElastiCache promotes the replica on a node failure, and the service reconnects through the primary endpoint; see "Loss of Redis" in [docs/deployment/aws.md](../deployment/aws.md#loss-of-redis). A replication group that does not recover is an AWS support case.
3. A Redis token that no longer matches, after a rotation, needs the tasks redeployed ([secret rotation](secret-rotation.md)).

## Verification

- A request over the limit answers 429 again, and one under it 2xx.
- Every replica logged `Redis available: the per-user rate limit applies again`, and `scf_rate_limit_store_errors_total` no longer rises.
- `scf-waf-blocked-requests` returns to OK.

Nothing needs repair after Redis returns: the counters are short-lived and start again from zero.

## Follow-up

- A limit changed for a client: record why, and whether the default should change for everyone.
- The alert `redis-unavailable` is a documented signal, not a deployed alarm; in AWS the log line can feed a metric filter on `/scf/api` ([observability](../observability.md#alerts-without-an-alarm)).
