# 008 · Deployment · Plan

How the local stack, the image, the seed, the load balancer's upstreams and the AWS Terraform are built and checked. The shared conventions and the test infrastructure are in [plan 000](../000-overview/plan.md); the configuration loader, the nginx limits and timeouts, health and shutdown are in [plan 007](../007-security-ops/plan.md). The spec wins over this plan.

## 1. Modules and files

| Path                                                            | Phase      | Purpose                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compose.yaml`                                                  | 05, 10     | 05-schema: the `postgres` healthcheck connects as `scf_owner`, since `scf` is gone. 10-runtime: the full stack of table 1.1 (section 2).                                                                                                                                                                                                              |
| `src/platform/db/migrate.ts`, `src/cli/migrate.ts`              | 10-runtime | `migrate.ts` runs node-pg-migrate's programmatic runner on a migrations folder with `MIGRATION_DATABASE_URL`; `src/cli/migrate.ts` is its executable entry point, compiled to `dist/cli/migrate.js`. One code path for `npm run migrate:up`, the `migrate` service, the scratch databases of the tests and the AWS migration task (DEP-R04, DEP-R05). |
| `Dockerfile`, `.dockerignore`                                   | 10-runtime | The two-stage image of section 3 (DEP-R18 to DEP-R22).                                                                                                                                                                                                                                                                                                |
| `src/healthcheck.ts`                                            | 10-runtime | Requests `http://127.0.0.1:${PORT}/health/live` with Node's `fetch` and exits 0 or 1 (DEP-R21).                                                                                                                                                                                                                                                       |
| `docker/nginx/templates/default.conf.template`                  | 10-runtime | This plan's part: the upstream over `api-1:3000` and `api-2:3000` with `zone`, `resolve` and `keepalive`, `resolver 127.0.0.11`, `proxy_next_upstream error timeout` with 2 tries, and the `error_page` location for 502, 503 and 504 with type `/problems/upstream-unavailable` and `Retry-After: 1` (DEP-R15, DEP-R16). Plan 007 writes the rest.   |
| `src/platform/config/config.ts`                                 | 10-runtime | The demo `JWT_SECRET` and `CURSOR_SECRET` of DEP-R35, refused when `NODE_ENV` is `production` (DEP-R07).                                                                                                                                                                                                                                              |
| `src/platform/logging/logger.ts`                                | 10-runtime | `replicaId` on every line, from `REPLICA_ID` or the host name; never in a response (DEP-R14).                                                                                                                                                                                                                                                         |
| `scripts/seed.ts`                                               | 10-runtime | `npm run seed`: `runSeed({http, clock, env, stdout, stderr})` with the behaviour of section 1.2 (DEP-R10 to DEP-R12).                                                                                                                                                                                                                                 |
| `.gitleaks.toml`                                                | 10-runtime | Only if gitleaks flags a demo value: an allowlist of exactly that value, anchored (DEP-R36).                                                                                                                                                                                                                                                          |
| `test/e2e/support/stack.ts`                                     | 11-e2e     | Starts, inspects and stops the stack with `docker compose` under its own project name, and reads container logs (section 5).                                                                                                                                                                                                                          |
| `infra/terraform/*.tf`, `infra/terraform/modules/<module>/*.tf` | 12-infra   | The root configuration and the seven modules of table 1.3, with the settings of sections 1.7 and 1.8 (DEP-R24 to DEP-R32, DEP-R37). The `backend` block is empty (partial configuration), and no provider sets credentials (DEP-R34).                                                                                                                 |
| `infra/policies/*.yaml`                                         | 12-infra   | Custom checkov policies for DEP-AC16 to DEP-AC23 and DEP-AC26, and the WAF rule of SEC-AC35.                                                                                                                                                                                                                                                          |
| `scripts/infra-validate.sh`, `package.json`                     | 12-infra   | `npm run infra:validate`: `terraform fmt -check`, `terraform init -backend=false`, `terraform validate`, `tflint` with the AWS ruleset and `checkov` with `infra/policies/`, each from a Docker image pinned by digest (section 1.7).                                                                                                                 |
| `.github/workflows/ci.yml`                                      | 12-infra   | The step `npm run infra:validate` in the `ci` job (DEP-R33).                                                                                                                                                                                                                                                                                          |
| `docs/deployment/aws.md`                                        | 12-infra   | The architecture of section 1.3, one section per component naming its module, the request path, deployment and migration steps, failure modes and a cost estimate (DEP-R23).                                                                                                                                                                          |

## 2. Data model changes

None. The roles, databases and init script are those of plan 000 section 3; `compose.yaml` only points each service at the role its URL names (section 1.4).

## 3. Local stack and image

**`compose.yaml`** (10-runtime), literal values except the tunables written as `${VAR:-default}`:

- `postgres` and `redis` as today, pinned by version and digest, and an explicit network `scf` with a fixed subnet, so that `TRUSTED_PROXY_CIDRS` can name it (SEC-AC10).
- `migrate`: the runtime image with the entrypoint `["node", "dist/cli/migrate.js", "up"]`, `MIGRATION_DATABASE_URL` as `scf_owner`, `depends_on: postgres: condition: service_healthy`.
- `api-1` and `api-2` from one YAML anchor: the runtime image, `DATABASE_URL` as `scf_app`, `REPLICA_ID` `api-1` and `api-2`, ports `127.0.0.1:3001:3000` and `127.0.0.1:3002:3000`, `TRUSTED_PROXY_CIDRS` set to the network's subnet, `stop_grace_period: 40s`, `depends_on` `migrate` completed successfully and `redis` started. `METRICS_PORT` is neither published nor exposed to nginx (SEC-R43).
- `nginx`: `nginx:1.28.x-alpine` pinned by version and digest, a stable release that supports `resolve` on `server` lines of an upstream (added to open-source nginx in 1.27.3); the template mounted under `/etc/nginx/templates/`, port `127.0.0.1:8080:8080`, starting once both replicas are healthy.
- `tools`: the build stage (`target: build`), profile `tools`, the replicas' variables plus `MIGRATION_DATABASE_URL`.
- No `env_file` anywhere (DEP-R06). The demo secrets are the values of DEP-R35.

**`Dockerfile`** (10-runtime):

| Stage     | Content                                                                                                                                                                                                                                                                                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `build`   | `FROM node:24.x-alpine@sha256:...`; `npm ci`; the sources; `npm run build`, which compiles `src/` to `dist/` and, from 09-hardening on (plan 007), copies `migrations/*.sql` to `dist/migrations/`, so the runtime stage needs no other folder and readiness knows the migrations it ships.                                                                                    |
| `runtime` | The same pinned base; `COPY` of `package.json` and `package-lock.json`, then `npm ci --omit=dev`, then `COPY --from=build` of `dist/` only; files owned by root, so the user `node` owns none; `USER node`; `HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 CMD ["node", "dist/healthcheck.js"]`; `ENTRYPOINT ["node", "dist/main.js"]` with no `CMD`. |

**nginx** (10-runtime): the upstream uses `zone` and `server api-1:3000 resolve`, with `resolver 127.0.0.11 valid=5s`, so a replica that restarts with another address is found again (DEP-AC10, DEP-AC11). `worker_processes 1` keeps the round robin strictly alternating, which DEP-AC09's count of at least 5 per replica relies on; a comment in the configuration says so, because with several workers each keeps its own round-robin position. `proxy_next_upstream error timeout` with `proxy_next_upstream_tries 2`, which nginx applies to a POST only before the request was sent (DEP-R15). The gateway `error_page` returns `application/problem+json` with `requestId` = `$request_id` or the client's `X-Request-Id`, and `add_header Retry-After 1 always` (DEP-R16).

**Seed** (10-runtime): refuses `NODE_ENV` `production`; polls `/health/ready` through `http://nginx:8080` for up to 60 s of the injected clock; mints the tokens of table 1.2 with `issueToken` (plan 006) and never prints them; for each customer, lists the accounts, creates only the missing currencies, and deposits only into an account it created in this run or whose history is empty; every request carries a fixed Idempotency-Key derived from the user and the step; it prints the users with their account ids, currencies and balances as one JSON document (DEP-R10 to DEP-R12).

## 4. AWS (12-infra)

The modules of table 1.3 with the settings of section 1.7 and the alarms of section 1.8. The service module holds three task definitions on the same image: the service (`node dist/main.js`, runtime role secret only), the migration (`node dist/cli/migrate.js up`, owner role secret), and the cleanup (`node dist/cli/idempotency-cleanup.js`, runtime role secret). Both entry points live under `src/cli/`, which `tsconfig.build.json` compiles into `dist/` like the rest of `src/`, and DEP-AC12 checks that the runtime stage ships `dist/` whole, with the EventBridge Scheduler schedule `rate(1 hour)` for the last (DEP-R28, DEP-R37). Secrets are declared without versions; no `random_password` and no literal secret value (DEP-R31). Before the first migration task, a one-time bootstrap step documented in `docs/deployment/aws.md` uses the RDS master credentials once to create `scf_owner` and `scf_app` and grant `scf_app` to `scf_owner` with admin option, as the local init script does, because the migrations name `scf_app` and `ALTER ROLE` needs that grant (DEP-R05, DEP-R28). Nothing in the repository runs `terraform apply`, `plan`, `destroy` or `import` (DEP-R34).

## 5. e2e harness

The e2e suite owns the stack. `test/e2e/support/stack.ts` runs every `docker compose` command with `COMPOSE_PROJECT_NAME=scf-e2e`, so the suite never touches the volumes of the developer's own `npm run infra:up`. Since both use the same host ports, it refuses to start while those ports are taken. The custom sequencer of plan 007 runs, in order:

1. the files that need empty volumes, and DEP-AC01's fresh clone (DEP-AC01, DEP-AC02, DEP-AC03, then DEP-AC04 and DEP-AC06);
2. every other e2e file, DEP-AC10 and DEP-AC11 among them, each restoring the replicas it stopped;
3. SEC-AC05, then SEC-AC01.

Only DEP-AC01 runs from a clone: it clones the repository at `HEAD` into a temporary folder, as its Given asks, and prints a warning when the working tree differs from `HEAD` (`git status --porcelain` not empty), since uncommitted changes are then not part of what it tests. Every other e2e file builds the stack from the working tree, so a local run needs no commit.

## 6. Error mapping

| Condition                                                               | Status        | Type                             | Extra headers                    | Stored for replay |
| ----------------------------------------------------------------------- | ------------- | -------------------------------- | -------------------------------- | ----------------- |
| nginx gets no response from a replica, or a broken one, or none in time | 502, 503, 504 | `/problems/upstream-unavailable` | `Retry-After: 1`, `X-Request-Id` | no                |
| `NODE_ENV` `production` with a demo `JWT_SECRET` or `CURSOR_SECRET`     | none          | the service does not start       |                                  | n/a               |
| the seed in production, or the API not ready within 60 s                | none          | non-zero exit, reason on stderr  |                                  | n/a               |

## 7. Acceptance criteria

| AC       | Level       | Phase      | Test file                                         |
| -------- | ----------- | ---------- | ------------------------------------------------- |
| DEP-AC01 | e2e         | 11-e2e     | `test/e2e/stack-start.test.ts`                    |
| DEP-AC02 | e2e         | 11-e2e     | `test/e2e/stack-start.test.ts`                    |
| DEP-AC03 | e2e         | 11-e2e     | `test/e2e/stack-failed-migration.test.ts`         |
| DEP-AC04 | e2e         | 11-e2e     | `test/e2e/migrations.test.ts`                     |
| DEP-AC05 | unit        | 10-runtime | `test/unit/deployment/demo-secrets.test.ts`       |
| DEP-AC06 | e2e         | 11-e2e     | `test/e2e/seed.test.ts`                           |
| DEP-AC07 | unit        | 10-runtime | `test/unit/deployment/seed.test.ts`               |
| DEP-AC08 | e2e         | 11-e2e     | `test/e2e/seed.test.ts`                           |
| DEP-AC09 | e2e         | 11-e2e     | `test/e2e/replicas-round-robin.test.ts`           |
| DEP-AC10 | e2e         | 11-e2e     | `test/e2e/gateway-errors.test.ts`                 |
| DEP-AC11 | e2e         | 11-e2e     | `test/e2e/replica-loss.test.ts`                   |
| DEP-AC12 | unit        | 10-runtime | `test/unit/deployment/dockerfile.test.ts`         |
| DEP-AC13 | e2e         | 11-e2e     | `test/e2e/container.test.ts`                      |
| DEP-AC14 | unit        | 12-infra   | `test/unit/deployment/aws-doc.test.ts`            |
| DEP-AC15 | ci          | 12-infra   | CI step `npm run infra:validate`                  |
| DEP-AC16 | ci          | 12-infra   | CI step `npm run infra:validate`                  |
| DEP-AC17 | ci          | 12-infra   | CI step `npm run infra:validate`                  |
| DEP-AC18 | ci          | 12-infra   | CI step `npm run infra:validate`                  |
| DEP-AC19 | ci          | 12-infra   | CI step `npm run infra:validate`                  |
| DEP-AC20 | ci          | 12-infra   | CI step `npm run infra:validate`                  |
| DEP-AC21 | ci          | 12-infra   | CI step `npm run infra:validate`                  |
| DEP-AC22 | ci          | 12-infra   | CI step `npm run infra:validate`                  |
| DEP-AC23 | ci          | 12-infra   | CI step `npm run infra:validate`                  |
| DEP-AC24 | unit        | 12-infra   | `test/unit/deployment/no-terraform-apply.test.ts` |
| DEP-AC25 | integration | 10-runtime | `test/integration/deployment/gitleaks.test.ts`    |
| DEP-AC26 | ci          | 12-infra   | CI step `npm run infra:validate`                  |

Notes:

- DEP-AC05 and DEP-AC12 read `compose.yaml` with the `yaml` package (plan 007 section 8).
- DEP-AC24 is placed in 12-infra, where the Terraform it searches first exists; before that, its Then about `backend` and `provider` blocks would hold vacuously.
- DEP-AC25 runs gitleaks from its Docker image, pinned by digest at the version `GITLEAKS_VERSION` of the CI job `secret-scan`, which the test reads from `.github/workflows/ci.yml`. The fake access key id is generated at run time and written only to a temporary folder.
- The `ci` ACs are covered once the CI step runs exactly `npm run infra:validate`. Each policy of `infra/policies/` names the AC it checks in its id, so a failure points to the AC.

## 8. ACs that cannot be tested as written

None found. Every e2e command of the harness sets `COMPOSE_PROJECT_NAME=scf-e2e`, approved by the owner on 2026-10-08, which overrides the `name:` of `compose.yaml`, so the e2e stack never deletes the developer's own volumes; the harness refuses to start while the stack's host ports are taken. DEP-AC05 and DEP-AC12 read `compose.yaml` with the `yaml` package (plan 007 section 8).
