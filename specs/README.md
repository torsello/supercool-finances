# Specs

Every behaviour of the service is described here before it is built. The workflow and its rules are in [AGENTS.md](../AGENTS.md#2-workflow-spec-first); this file explains how a spec is written and how it is traced to tests.

## Layout

```
specs/
  README.md                 this file, with the index below
  NNN-name/
    spec.md                 requirements and acceptance criteria
    plan.md                 how it will be built (phase 04-plans)
    tasks.md                ordered implementation tasks (phase 04-plans)
```

`NNN` is a three-digit number in creation order. `000-overview` holds what every spec shares: the glossary, the currency table and the conventions common to all modules.

## Status

| Status        | Meaning                                                                  | Effect on `npm run trace`                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Draft`       | Being written. Requirements and ACs may still change.                    | ACs without proof are `pending`, except those named by a ticked task, which must be proven.                                                                                |
| `Approved`    | Accepted by the owner. Changing requirements or ACs needs the owner.     | Same as `Draft`.                                                                                                                                                           |
| `Implemented` | Built and proven. All specs move here together in phase 13-final-review. | Every AC must be proven, or the check fails (exit 1). An AC whose project report is absent is `unverified` and fails only when `--require` names that project (see below). |

The status is the line `- **Status:** <value>` near the top of `spec.md`, with exactly one of the three values.

## Writing a spec

Use the `spec` skill (`/spec NNN-name PFX`). It follows [the template](../.claude/skills/spec/template.md): context, EARS requirements, acceptance criteria, error catalogue, invariants, out of scope and open questions.

**ID prefix.** Each spec has its own short uppercase prefix, unique across specs, for example `MOV` for movements. It is declared as `- **ID prefix:** MOV` and used by every ID in that spec. IDs are never reused once removed.

**Requirements** use EARS notation, one behaviour per line, with IDs `PFX-R01`, `PFX-R02`, ...

| Pattern      | Form                                                      |
| ------------ | --------------------------------------------------------- |
| Ubiquitous   | THE SYSTEM SHALL <response>.                              |
| Event-driven | WHEN <trigger> THE SYSTEM SHALL <response>.               |
| Unwanted     | IF <unwanted condition> THEN THE SYSTEM SHALL <response>. |
| State-driven | WHILE <state> THE SYSTEM SHALL <response>.                |
| Optional     | WHERE <feature is present> THE SYSTEM SHALL <response>.   |

**Acceptance criteria** have IDs `PFX-AC01`, `PFX-AC02`, ... (two digits). Each one is a level-3 heading in exactly this form, because `npm run trace` reads it:

```markdown
### MOV-AC03 · Withdrawal larger than the balance is rejected

- **Level:** integration
- **Covers:** MOV-R04
- **Given** a customer account with balance "1000" EUR owned by user A
- **When** user A posts a withdrawal of "1500" EUR with Idempotency-Key k1
- **Then** 422 with type /problems/insufficient-funds, and the balance stays "1000" EUR
```

- `Level` is exactly `unit`, `integration`, `e2e` or `ci`.
- Only when no test can prove an AC (for example Terraform validated in CI), the level is `ci` and the AC adds `- **Verified by:** <CI job and the npm run script its step runs>`. Any other AC with a `Verified by` line fails the check. The line must name at least one `npm run <script>`, and every script it names must be in `package.json` and be the whole command of a step of `.github/workflows/ci.yml`: the step's `run` is exactly `npm run <script>`, optionally followed by plain arguments (letters, digits and `_ . , : = / @ % + -`), as a single command, with nothing before or after it. Comments, blank lines and a line continued with a backslash do not count as commands. Anything else is not proof: an assignment or `env` before the script, `!`, `if`, `echo`, a pipe, `&&`, `||`, `;`, `&`, a redirection, a quote, a substitution, an npm flag before the script name, or a second command in the step. The step and its job must also be without `continue-on-error` (other than `false`) and `if: false`. Until all of that holds, the AC is not covered.
- An AC heading may be indented by up to three spaces, as any Markdown heading. A heading that starts like an AC ID, in any case and at any indent, but is not exactly `### PFX-ACnn` followed by a space or the end of the line (for example `### MOV-AC3`, `#### MOV-AC03`, `### MOV-AC03:`, `### mov-ac03` or a heading indented by four spaces) fails the check, and so does an AC ID whose prefix is not the spec's `ID prefix`.
- Headings inside fenced code blocks are examples, not ACs. A fence closes only with the same character (backtick or tilde) repeated at least as many times.

## Tests name the AC they prove

Every AC is proven by at least one test whose name contains its ID:

```ts
it('MOV-AC03 rejects a withdrawal larger than the balance', async () => { ... });
```

Proof comes from what Vitest actually ran, never from the test source. `npm test` and `npm run test:integration` each write a JSON report (`reports/vitest-unit.json`, `reports/vitest-integration.json`, and later `reports/vitest-e2e.json`), and `npm run trace` reads them.

- An AC is covered only by a test that **passed**, whose full name (its `describe` titles plus its own title) contains the AC ID, in the report of the project that matches the AC's `Level`. A unit test never proves an integration AC.
- Skipped, todo and failed tests prove nothing, and neither does a test that never ran. A table-driven test counts through each generated case, for example `it.each(cases)('MOV-AC07 rejects %s', ...)`.
- Two guards in every Vitest project (`vitest.shared.ts`) keep a passing test meaningful: a test marked `fails`, in any syntax, fails at runtime (`test/setup/forbid-fails.ts`), because Vitest would report it as passed when its body fails; and a test that makes no assertion fails (`expect.requireAssertions`).
- An ID that no spec defines fails the check wherever it appears in a test name, whatever the test's status.

## Traceability check

```sh
npm test && npm run test:integration   # write the reports first
npm run trace                          # print the AC table and fail on gaps
npm run trace -- --require unit,integration   # also fail if a report is missing (CI)
npm run trace -- --write               # also write docs/traceability.md
```

The check prints every AC with its spec, status, level, coverage and proof (test files, or the `Verified by` command). An AC is **required** when its spec is `Implemented` or a ticked task in any `specs/*/tasks.md` names it. A task is a `- [ ]` or `- [x]` line, and it names its AC IDs on that line. Coverage is one of:

| Coverage     | Meaning                                                                                                                                                                                                                                              |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `covered`    | A passing test of its level names it, or, for level `ci`, it has a `Verified by` line naming at least one `npm run <script>`, each a script in `package.json` and the whole command of a step of `.github/workflows/ci.yml` that can fail the build. |
| `pending`    | Not proven, and not required yet.                                                                                                                                                                                                                    |
| `missing`    | Required and not proven. Fails the check.                                                                                                                                                                                                            |
| `unverified` | The report of its level is absent, so that project was not run. Fails only with `--require`.                                                                                                                                                         |

The check exits with code 1 when:

- a required AC is `missing`, or any test naming it did not pass (skipped, todo or failed), even if another test naming it passed;
- a project named in `--require` has no report, or a report is not a Vitest JSON report;
- a test or a task names an AC ID that no spec defines;
- a spec or task file is malformed: missing or unknown status, missing ID prefix, an ID prefix used by two specs, an AC ID defined twice or with another spec's prefix, a mistyped AC heading, a missing or unknown level, a `Verified by` line on an AC that is not level `ci`, a code fence that is never closed, a `specs/NNN-*` folder without `spec.md`, a list item with a checkbox that is not exactly `- [ ]` or `- [x]`, or an AC ID in `tasks.md` that is not on a task's checkbox line.

Tick a task in `tasks.md` as soon as it is done, so its ACs are enforced from then on, long before the specs move to `Implemented`. Run the check after every implementation step (AGENTS.md), after running the tests so the reports are fresh. CI and `/ship` both run `npm run trace -- --require unit,integration` after the unit and integration tests. e2e ACs are therefore `unverified`, not enforced, until phase 12, when CI runs the e2e suite and adds `e2e` to `--require`. `docs/traceability.md` is git-ignored until the final phase, when CI starts checking that it is fresh. `test/fixtures/` holds sample specs and reports for the checker's own tests.

## Changing a spec

- If code and spec disagree, the spec wins. Ask the owner before changing a requirement or an AC; metadata (Related ADRs, this index) can be updated freely.
- When an ID is renamed or removed, search tests and docs for it and update them in the same change.

## Index

Keep this table up to date whenever a spec is added or its status changes.

| #   | Spec                                                 | Prefix | Status   | Scope                                                                                                       | Depends on                        |
| --- | ---------------------------------------------------- | ------ | -------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 000 | [overview](000-overview/spec.md)                     | SYS    | Approved | Roles, glossary, currencies, status-code rule, order of checks, shared errors and global invariants         | none                              |
| 001 | [accounts](001-accounts/spec.md)                     | ACC    | Approved | Create, read and list accounts, history, freeze, unfreeze and close                                         | 000, 002, 003, 004, 005, 006, 007 |
| 002 | [ledger](002-ledger/spec.md)                         | LED    | Approved | Double-entry records, settlement accounts, database checks, amount limits, reconciliation                   | 000, 001, 003, 004, 005           |
| 003 | [money movements](003-money-movements/spec.md)       | MOV    | Approved | Deposits, withdrawals, transfers, locking, reading a transaction                                            | 000, 001, 002, 004, 005, 007      |
| 004 | [reversals](004-reversals/spec.md)                   | REV    | Approved | Compensating transactions by operators                                                                      | 000, 001, 002, 003, 005           |
| 005 | [idempotency](005-idempotency/spec.md)               | IDM    | Approved | `Idempotency-Key`, fingerprint, replay, what is stored, expiry and cleanup                                  | 000, 001, 002, 003, 004, 007, 008 |
| 006 | [auth](006-auth/spec.md)                             | AUT    | Approved | JWT verification, token CLI, authorization matrix                                                           | 000, 001, 003, 004, 005, 007      |
| 007 | [security and operability](007-security-ops/spec.md) | SEC    | Approved | Rate limits, body limits, headers, logs, health, shutdown, timeouts, pool, configuration, metrics, API docs | 000 to 006, 008                   |
| 008 | [deployment](008-deployment/spec.md)                 | DEP    | Approved | Docker Compose stack, seed, image, failover, AWS Terraform                                                  | 000, 002, 005, 006, 007           |

Shared vocabulary lives in spec 000 only: a term, role, problem type or status code is defined once there or in the capability spec that owns it, and every other spec refers to it. Every spec is `Approved` with no open question: each decision is stated in the spec as a rule and cited across specs by requirement ID or section. Spec 000 lists the AC IDs retired on 2026-10-07, which are never reused.
