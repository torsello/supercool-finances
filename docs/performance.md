# Performance

The latest result of the load test of SYS-R20 (`scripts/load-test.ts`), written by the test itself. It runs as `npm run load` or `make load` against the stack of `docker compose up --build --wait`, and the e2e test of SYS-AC17 runs it too, so every e2e run rewrites this file. The rate is `LOAD_RATE_PER_SECOND`, 200 requests per second by default; the CI job `e2e` runs at 100, because its runner has 2 CPUs for the whole stack and the generator, and the result committed here is a local run at 200. The p99 target is reported, not guaranteed: a run that misses it does not fail. A run fails on a 5xx, a connection error, a lost request, a ledger that does not reconcile, or a generator that fell behind its schedule.

## Machine

- Host: Apple M2 Pro, 10 CPUs, 16.0 GiB of memory; macOS 26.5.1 (arm64); Node.js v24.21.0.
- Docker: Docker Engine 29.5.2 on Ubuntu 24.04.4 LTS, 4 CPUs and 5.8 GiB available to containers.
- Stack: two replicas behind nginx, with PostgreSQL and Redis, from `compose.yaml` with its defaults. The client runs on the host and reaches nginx at http://localhost:8080, so the latencies include Docker's port forwarding.

## Method

- Setup: 1000 customers, each with a pair of EUR accounts funded with "100000" EUR each through the API, and 10 operators: 4000 setup requests in 16 s.
- Load: an open model. 12000 single deposits, withdrawals and transfers of "100" EUR in equal thirds, each with its own Idempotency-Key, scheduled one every 5 ms for a constant 200 requests per second over 60 s. Each leaves at its moment whether or not earlier ones were answered, over at most 256 connections, and its latency runs from its scheduled moment, so a slow answer, or a wait for a free connection, counts in full. Deposits rotate over the operators; withdrawals and transfers (from one account of a pair to the other) over the customers (SEC-AC05).
- Count: every request still in flight when the schedule ends is drained, so each one ends as an answer, a connection error, or a loss after 60 s without an answer.
- Finished at 2026-10-09T12:30:14.468Z.

## Results

| Measure                   |                                                   Value |
| ------------------------- | ------------------------------------------------------: |
| p50 latency               |                                                    4 ms |
| p95 latency               |                                                    6 ms |
| p99 latency               |                                                 16.4 ms |
| Maximum latency           |                                                163.6 ms |
| Requests sent             |             12000 of 12000 scheduled, at 200 per second |
| Achieved throughput       |                                200 responses per second |
| Responses                 | 12000 (4000 deposits, 4000 withdrawals, 4000 transfers) |
| Non-2xx responses         |                                                       0 |
| 5xx responses             |                                                       0 |
| Connection errors         |                                                       0 |
| Lost requests             |                                                       0 |
| Drain after the last send |                                                     0 s |

- Status codes: 201: 12000.
- Target p99 under 300 ms: met: p99 16.4 ms is under 300 ms.
- Generator: kept its schedule: every request left at most 10.3 ms after its moment (p99 1.3 ms; the limit is 100 ms).
- Reconciliation after the run: clean: every cached balance matches the ledger and every currency sums to zero (SYS-AC11, SYS-AC12).
