# 006 · Auth · Plan

How a bearer token is read and verified, how the caller's identity and role reach the rest of the service, how the role check of SYS-R31 answers 403, and how the token script mints tokens. The shared conventions, the request pipeline and the error model are in [plan 000](../000-overview/plan.md). The spec wins over this plan.

## 1. Modules and files

| Path                                                         | Phase  | Purpose                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/modules/auth/domain/caller.ts`                          | 08-api | `Caller` (`userId` in canonical lowercase, `role`), the only identity every use case receives (AUT-R07).                                                                                                                                                                                                                      |
| `src/modules/auth/domain/errors.ts`                          | 08-api | `Unauthenticated` with an internal `reason` (`missing`, `malformed`, `algorithm`, `signature`, `expired`, `not_yet_valid`, `lifetime`, `claims`), and `Forbidden`.                                                                                                                                                            |
| `src/modules/auth/application/token-verifier.ts`             | 08-api | `verifyToken(token, config, now)`: the checks of section 1.1 with an injected clock; no cache or state between calls (AUT-R02 to AUT-R05, AUT-R21).                                                                                                                                                                           |
| `src/modules/auth/application/token-issuer.ts`               | 08-api | `issueToken(caller, settings, now)`, with `caller` the `sub` and role and `settings` the token settings, used by the token script.                                                                                                                                                                                            |
| `src/modules/auth/application/permissions.ts`                | 08-api | The role per operation of table 1.1 of spec 000, one entry per route of table 1.3 (SYS-R03, AUT-R10, AUT-R11).                                                                                                                                                                                                                |
| `src/modules/auth/adapters/http/authenticate.ts`             | 08-api | `onRequest` hook on every `/v1` route: reads only `Authorization`, answers 401 with the one body and header of section 1.5, logs the `warn` line with the reason (AUT-R01, AUT-R06, AUT-R08, AUT-R19).                                                                                                                        |
| `src/modules/auth/adapters/http/authorize.ts`                | 08-api | `onRequest` hook after authentication (and after the rate limit, from 09-hardening): the route's `config.roles` against the caller's role, 403 before any id or body is looked at (SYS-R04).                                                                                                                                  |
| `src/modules/auth/adapters/cli/token.ts`, `scripts/token.ts` | 08-api | `npm run token -- --sub <id> --role <role>` (section 1.2), as `main(argv, env, stdout, stderr)` returning the exit code, so a unit test can run it.                                                                                                                                                                           |
| `src/platform/config/config.ts`                              | 08-api | `JWT_SECRET` (at least 32 bytes in UTF-8, used as given), `JWT_ISSUER`, `JWT_AUDIENCE` (required, not empty) (AUT-R18). The token script loads only this section of the same loader, so it needs no database or cursor setting.                                                                                               |
| `.env.example`                                               | 08-api | `JWT_ISSUER=supercool-finances-local` and `JWT_AUDIENCE=supercool-finances-api`; `npm run env:sync` adds them.                                                                                                                                                                                                                |
| `test/support/tokens.ts`                                     | 08-api | Signs the reference token V and its variants of section 3 of the spec with the test secret, for unit and integration tests. It signs with `node:crypto`, not `issueToken` or `jose`, on purpose: tests need headers `jose` refuses to sign, such as `alg` `none` or a `jwk`, and a helper independent of the code under test. |

## 2. Data model changes

None. The caller's id and role are written by other plans into `audit_records` (`actor_id`, `actor_role`) and `idempotency_keys` (`user_id`), always from `Caller`.

## 3. Verification

`authenticate.ts` takes the `Authorization` header and nothing else: not the query string (`access_token`), the body, a cookie or another header (AUT-R01, AUT-R08). The header must be exactly one credential: the scheme `Bearer` in any letter case, one space, and a compact JWS of three base64url segments; anything else is `malformed`, and no header at all is `missing`. A token given straight to `verifyToken` that is not three segments, such as a five-segment JWE, gives `algorithm` when its header decodes and declares an encryption algorithm, and `malformed` otherwise. `verifyToken` then checks, in this order. `jose` is used only for the signature, through `compactVerify`; `jwtVerify` is never used, because it checks `exp` and `nbf` against the real clock with no tolerance before our own checks could run, and would log the wrong reason:

| #   | Check                                                                                                                                                                                                                                                                                                                                         | Reason on failure                                                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The protected header decodes as JSON, has `alg` exactly `HS256` and no `crit`; a key named or embedded in the header (`kid`, `jwk`, `jku`, `x5u`, `x5c`) is never used                                                                                                                                                                        | `malformed` when the header does not decode as a JSON object; `algorithm` for a `crit` parameter, an `alg` other than `HS256` (`none` included), and a JWE |
| 2   | `compactVerify(token, key, { algorithms: ['HS256'] })` with `JWT_SECRET` as a raw UTF-8 key passed directly, never a key resolver, so no key named, embedded or fetched from the header is ever used; `none`, other HMAC sizes, RS256 and ES256 are refused whatever the header says. Its payload is then parsed as a JSON object in our code | `signature`, or `malformed` when the payload is not a JSON object                                                                                          |
| 3   | `sub` a UUID (then lowercased), `role` exactly `customer` or `operator`, `iat` and `exp` numbers, `iss` equal to `JWT_ISSUER`, `aud` equal to `JWT_AUDIENCE` or an array containing it                                                                                                                                                        | `claims`                                                                                                                                                   |
| 4   | `now < exp + 5`                                                                                                                                                                                                                                                                                                                               | `expired`                                                                                                                                                  |
| 5   | `iat <= now + 5`, and `nbf <= now + 5` when present                                                                                                                                                                                                                                                                                           | `not_yet_valid`                                                                                                                                            |
| 6   | `0 < exp − iat <= 900`                                                                                                                                                                                                                                                                                                                        | `lifetime`                                                                                                                                                 |

Every claim check (3 to 6) is our own code, with the injected clock and the 5-second tolerance fixed in code (section 1.1), so each failure has its own reason (AUT-R04, AUT-R05, AUT-R19). Extra claims, `typ` and `kid` are ignored. Every failure is one `Unauthenticated` error; the error handler gives every 401 the same body and `WWW-Authenticate: Bearer realm="supercool-finances"` (section 1.5), and the hook logs one `warn` line with `reqId` and the reason, never the token or a claim value (AUT-R19). Health checks and `/docs` have no authentication hook, so they never read the header (AUT-R20).

Unknown members of a body or query string, such as `ownerId`, `userId`, `sub` or `role`, are refused by the strict schemas of the capability plans at the validation step (AUT-R09); a header such as `X-User-Id` is never read.

## 4. Token script

`npm run token -- --sub <id> --role <role>` parses its arguments with `node:util` `parseArgs` in strict mode, so an unknown argument such as `--ttl` fails (AUT-R17). It loads the auth section of the configuration loader from the environment and `.env`, and applies the checks of AUT-R18. On success it prints one line, a token with header `{"alg": "HS256", "typ": "JWT"}` and claims `sub` (lowercase), `role`, `iat` (current time in whole seconds, rounded down), `exp` = `iat` + 900, `iss` and `aud` as a string, and exits 0 (AUT-R16). On failure it prints nothing on stdout, one message naming the argument or variable on stderr, never a value of `JWT_SECRET`, and exits 1.

## 5. Error mapping

| Typed error                    | When                                                                     | Status | Type                         | Extra headers                                         | Stored for replay |
| ------------------------------ | ------------------------------------------------------------------------ | ------ | ---------------------------- | ----------------------------------------------------- | ----------------- |
| `Unauthenticated` (any reason) | no header, not one Bearer credential, or a failed check of section 3     | 401    | `/problems/unauthenticated`  | `WWW-Authenticate: Bearer realm="supercool-finances"` | no                |
| `Forbidden`                    | the route's roles exclude the caller's role, whatever ids the path names | 403    | `/problems/forbidden`        |                                                       | no                |
| `ValidationFailed`             | an unknown body or query member (`ownerId`, `userId`, `sub`, `role`)     | 422    | `/problems/validation-error` |                                                       | no                |
| `NotFound`                     | another customer's account in the path (plans 001 and 003)               | 404    | `/problems/not-found`        |                                                       | yes for movements |
| `ConfigError`                  | `JWT_SECRET`, `JWT_ISSUER` or `JWT_AUDIENCE` invalid                     | none   | the app is not built         |                                                       | n/a               |

## 6. Acceptance criteria

| AC       | Level       | Phase  | Test file                                         |
| -------- | ----------- | ------ | ------------------------------------------------- |
| AUT-AC01 | unit        | 08-api | `test/unit/auth/token-verifier.test.ts`           |
| AUT-AC02 | integration | 08-api | `test/integration/auth/unauthenticated.test.ts`   |
| AUT-AC03 | unit        | 08-api | `test/unit/auth/token-verifier.test.ts`           |
| AUT-AC04 | unit        | 08-api | `test/unit/auth/token-verifier.test.ts`           |
| AUT-AC05 | unit        | 08-api | `test/unit/auth/token-verifier.test.ts`           |
| AUT-AC06 | integration | 08-api | `test/integration/auth/auth-logs.test.ts`         |
| AUT-AC07 | integration | 08-api | `test/integration/auth/forbidden.test.ts`         |
| AUT-AC08 | integration | 08-api | `test/integration/auth/forbidden.test.ts`         |
| AUT-AC09 | integration | 08-api | `test/integration/auth/foreign-accounts.test.ts`  |
| AUT-AC10 | integration | 08-api | `test/integration/auth/foreign-accounts.test.ts`  |
| AUT-AC11 | integration | 08-api | `test/integration/auth/identity-source.test.ts`   |
| AUT-AC12 | integration | 08-api | `test/integration/auth/token-script.test.ts`      |
| AUT-AC13 | unit        | 08-api | `test/unit/auth/token-script.test.ts`             |
| AUT-AC14 | integration | 08-api | `test/integration/auth/no-token-endpoint.test.ts` |
| AUT-AC15 | unit        | 08-api | `test/unit/platform/config.test.ts`               |
| AUT-AC16 | e2e         | 11-e2e | `test/e2e/authorization-matrix.test.ts`           |

Notes:

- The verifier ACs (AUT-AC03 to AUT-AC05) are unit level but name "the error type that the HTTP edge maps to 401", so they are proven with `toProblem`. In step 1 of the 08-api order (plan 000 section 1) the verifier tests carry requirement IDs (AUT-R02 to AUT-R05); a step 6 task extends them to AUT-AC01, AUT-AC03, AUT-AC04 and AUT-AC05 once `toProblem` exists, as SYS-AC16 does.
- AUT-AC02 needs `/docs`, which is served from 08-api (plan 007).
- AUT-AC12 runs `npm run --silent token` as a child process with the test configuration in its environment.
- AUT-AC16 holds its 50 cases in one table in the test file, and checks that the table matches table 1.3 of the spec: it parses the Markdown table of the spec and compares number, endpoint, column and expected answer.

## 7. ACs that cannot be tested as written

None found. Every AC of this spec can be proven as written at its level, in the phase listed above.
