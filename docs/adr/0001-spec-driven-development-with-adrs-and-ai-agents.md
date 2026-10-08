# ADR-0001: Spec-driven development with ADRs and AI agents

- **Status:** Accepted
- **Date:** 2026-10-07
- **Related specs:** 000-overview, 001-accounts, 002-ledger, 003-money-movements, 004-reversals, 005-idempotency, 006-auth, 007-security-ops, 008-deployment

## Context and problem

The service is built largely by AI agents, working in one session per phase (AGENTS.md section 7), and it moves money: a small behavioural mistake (a lost update, a duplicated movement, an account visible to the wrong customer) is a correctness failure, not a cosmetic one. AI output is fast to produce and slow to verify. The question is how to define behaviour, record rationale and check that what was built is what was asked, in a way that holds across many sessions that share no chat history.

## Decision drivers

- Behaviour must be defined before code, so that an agent implements a contract instead of inventing one.
- Every claim of "done" must be checkable by a machine, not by trusting the agent's summary.
- Rationale must survive between sessions and reach reviewers, so that a later session does not quietly undo an earlier decision.
- Review must be independent of the agent that wrote the change.
- The process must cost little enough to run on every phase, starting with the first implementation phase.

## Considered options

### Option A: Spec-driven development with ADRs, AGENTS.md and an enforced traceability gate

Behaviour lives in `specs/NNN-name/spec.md` as EARS requirements and Given/When/Then acceptance criteria with IDs such as `MOV-AC03`. Decisions live in `docs/adr/`. Agents follow `AGENTS.md`. Every test name contains the ID of the AC it proves, and `npm run trace` checks the proof.

- **Pros:**
  - Each AC has one machine-checkable proof: a test whose name holds its ID and which actually ran and passed. `npm run trace` reads the Vitest JSON reports in `reports/`, not the test source, so a skipped, failing or never-run test does not count as proof.
  - The gate starts with the first implementation phase: an AC named by a ticked task in `tasks.md` must be proven whatever the spec's status, so coverage cannot be postponed to the end.
  - AC levels (`unit`, `integration`, `e2e`, `ci`) are checked against the report of the matching project, so an integration guarantee cannot be "proven" by a unit test with mocks.
  - ADRs keep the why next to the what; a reviewer, human or AI, can check code against both.
  - `AGENTS.md` gives every session the same rules (money in `bigint`, locking order, idempotency), so behaviour does not depend on what one chat happened to say.
  - `/audit` runs a separate agent that has not seen the conversation, so the review is not anchored on the author's reasoning.
- **Cons:**
  - Slower start: phases 02 to 04 produce no running feature.
  - The specs are long and precise, and keeping them, the ADRs, OpenAPI and the code in step is real work (AGENTS.md section 10).
  - The traceability checker is custom code (`scripts/traceability.ts`) that must itself be tested and maintained.
  - A test name containing an AC ID proves that a test exists and passed, not that it asserts what the AC says; that still needs review.

### Option B: Code first, documentation at the end

- **Pros:**
  - Fastest path to a running service; no up-front spec or planning phases.
  - Less text to maintain while the design is still moving.
- **Cons:**
  - Behaviour and rationale drift: the documentation describes what the code happens to do, written after the fact.
  - AI output is hard to verify, because there is no contract to verify it against; review falls back on reading code.
  - Decisions made in one session are invisible to the next, so they get re-litigated or silently reversed.
  - Coverage of the money invariants is whatever the tests happened to cover.

### Option C: Specs and ADRs without an enforced gate

- **Pros:**
  - Keeps most of the clarity of Option A without a custom checker.
- **Cons:**
  - Nothing stops an agent from marking a task done with a test that is skipped, mis-named or missing; the specs become aspirational.

## Decision

Chosen option: **Option A**, because behaviour defined in specs with acceptance criteria before code, decisions recorded as ADRs, agents bound by `AGENTS.md` and an independent `/audit` in the workflow make AI output verifiable, while code first lets behaviour and rationale drift. The gate is what makes the specs binding: every AC is proven by a test that actually ran and passed, read from Vitest's JSON reports rather than the source, and enforced for every ticked task, so it works from the first implementation phase.

The workflow is the one in AGENTS.md section 2: spec, ADR, plan and tasks, tests first, then code. Specs are `Draft`, then `Approved` by the owner, and all move to `Implemented` together in phase 13-final-review, when every AC of every spec must be proven (specs/README.md). CI and `/ship` run `npm run trace -- --require unit,integration`; e2e ACs are enforced from phase 12, when CI runs the e2e suite. `/ship` commits and pushes only after the quality gates pass. The workflow runs `/audit` before each push, and `/ship` reports its last verdict in the pull request; `/ship` does not enforce it.

## Consequences

### Positive

- Every AC in specs 000 to 008 has a stated level and will have a named, passing test; "done" is a command result, not a claim.
- Reviewers can trace any line of behaviour to a requirement and any design choice to an ADR.
- A new session starts from the repository alone (specs, ADRs, `AGENTS.md`), which is also what the AI usage log in `docs/ai/` shows.

### Negative / costs

- Every behaviour change costs a spec change first, and changing an `Approved` spec's requirements needs the owner.
- The specs are long; agents and reviewers spend context reading them.
- The checker is part of the trusted base: a bug in it can let an unproven AC through. It is covered by its own tests (`test/unit/traceability.test.ts` and the fixtures in `test/fixtures/traceability/`).

### To monitor

- `npm run trace` output in CI: the number of `pending` ACs should fall phase by phase and reach zero in phase 13.
- `/audit` findings of the kind "behaviour without an AC" or "test does not assert its AC": a recurring pattern means the gate is being satisfied in letter only.

### Follow-ups

- Phase 04-plans writes `plan.md` and `tasks.md` for every spec, with AC IDs on each task line.
- Phase 12 adds the e2e report to `--require`.
- Phase 13 moves every spec to `Implemented` and starts checking that `docs/traceability.md` is fresh.
