# Changelog

The history of the project, grouped by phase, newest first. It follows the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), but each section is a phase rather than a release: the project has no release tags, and `package.json` stays at version 0.1.0.

Each phase is developed on a branch `phase/NN-name` and merged into `main` through a pull request ([AGENTS.md section 8](AGENTS.md#8-git)). The entries are the Conventional Commits of that branch, with their short hashes. The AI sessions behind each phase are in [docs/ai/](docs/ai/README.md).

## Unreleased: 14-docs

In progress on the branch `phase/14-docs`. No commits yet.

## 13-final-review

[Pull request #16](https://github.com/torsello/supercool-finances/pull/16), merged on 2026-10-09.

### Tests

- Prove every clause of the ACs found weak in the final review (`c7e6f1b`)

### Docs

- Mark every spec Implemented and track `docs/traceability.md` (`aae6011`)
- Align spec 007 section 1.9 with the role settings and log part 2 (`06bb41f`)
- Add the final transcript of phase 13 (`45c3cf4`)

## 12b-observability

[Pull request #15](https://github.com/torsello/supercool-finances/pull/15), merged on 2026-10-09.

### Features

- Optional dashboards and error reporting (`0193ef7`)

### Fixes

- Close the audit findings and start counters at 0 (`f2b3066`)

### CI

- Run once per pull request (`c2e8874`)

### Docs

- Update the transcript of the 12b follow-up session (`1e78f19`)

## 12-infra

[Pull request #14](https://github.com/torsello/supercool-finances/pull/14), merged on 2026-10-09.

### Features

- Terraform for AWS with validated checkov policies (`21015ef`)

### Fixes

- Run the CI load test at 100 per second and report 5xx causes (`3087fcc`)

### CI

- Full CI pipeline with e2e, traceability and security jobs (`33710ce`)
- Pin runners to ubuntu-24.04 and add the phase 12 transcript (`dfb96c2`)

### Docs

- Add the final transcript of phase 12 (`3fff61c`)

## 11-e2e

[Pull request #13](https://github.com/torsello/supercool-finances/pull/13), merged on 2026-10-09.

### Tests

- E2E suite on its own Compose stack and open-model load test (`0ad5db1`)

### Docs

- Add the final transcript of phase 11 (`9af9ef4`)

## 10-runtime

[Pull request #10](https://github.com/torsello/supercool-finances/pull/10), merged on 2026-10-08.

### Features

- Local stack with two replicas behind nginx (`8bf0d69`)

### Docs

- Add the final transcript of phase 10 (`6736041`)

## 09-hardening

[Pull request #9](https://github.com/torsello/supercool-finances/pull/9), merged on 2026-10-08.

### Features

- Edge hardening, rate limit, redaction and metrics (`8460583`)
- Readiness, shutdown, pool and request timeouts (`6887669`)

### Fixes

- Install the signal handlers before listening (`aa3450d`)

### Tests

- Make the LED-AC15 overlap check robust (`e67963d`)

### Docs

- Add the final transcript of phase 09 (`224b796`)

## 08-api

[Pull request #8](https://github.com/torsello/supercool-finances/pull/8), merged on 2026-10-08.

### Features

- Auth, error handler and request pipeline (`9e0614a`)
- Account routes under `/v1` (`b2aaf70`)
- Idempotency wiring, movement and reversal routes (`789263d`)

### Tests

- Remaining HTTP acceptance criteria, request ids, API docs (`a480036`)

### Docs

- OpenAPI document, export, lint and CI step (`9353b29`)
- Add the final transcript of phase 08 (`d1d4c7e`)

## 07-idempotency

[Pull request #7](https://github.com/torsello/supercool-finances/pull/7), merged on 2026-10-08.

### Features

- Key step, idempotent runner and cleanup command (`cbcf370`)

### Docs

- Add the final transcript of phase 07 (`d1183ed`)

## 06-domain

[Pull request #6](https://github.com/torsello/supercool-finances/pull/6), merged on 2026-10-08.

### Features

- Accounts module, transaction runner and module lint rules (`5cbfa9e`)
- Ledger, money movements and reconciliation domain (`376dd5d`)
- Reversals domain and use case (`6e91577`)

### Docs

- Add the final transcript of phase 06 (`6997715`)

## 05-schema

[Pull request #5](https://github.com/torsello/supercool-finances/pull/5), merged on 2026-10-08.

### Features

- Roles, migrations and database checks (`6614fb0`)

### Docs

- Add the final transcript of phase 05 (`1a61efc`)

## 04-plans

[Pull request #4](https://github.com/torsello/supercool-finances/pull/4), merged on 2026-10-08.

### Docs

- Plan and tasks for specs 000-008, ADR-0021 and ADR-0022 (`fc2a4a5`)
- Add the final transcript of phase 04 (`7f058cf`)

## 03-adrs

[Pull request #3](https://github.com/torsello/supercool-finances/pull/3), merged on 2026-10-08.

### Docs

- Record the twenty architecture decisions of phase 03 (`c0e45ef`)
- Add the final transcript of phase 03 (`56b3d5e`)

## 02-specs

[Pull request #2](https://github.com/torsello/supercool-finances/pull/2), merged on 2026-10-07.

### Features

- Add specs 000 and 001 and the traceability gate (`8f3078d`)
- Add ledger and money movement specs, harden the trace gate (`6b56b6a`)
- Add reversals and idempotency specs, tighten the trace gate (`ebe9ef3`)
- Add auth, security-ops and deployment specs, tighten the trace gate (`7b31476`)

### Fixes

- Apply audit follow-ups to specs 000 and 001 (`c130c51`)

### Docs

- Approve all specs, fold decisions in as rules, harden trace gate (`028ae10`)
- Add the final transcript of phase 02 (`236768a`)

## 01-bootstrap

[Pull request #1](https://github.com/torsello/supercool-finances/pull/1), merged on 2026-10-07.

### Build

- Bootstrap toolchain and walking skeleton (`39d6076`)

### CI

- Add CI workflow, README and audit hardening (`4606447`)

### Fixes

- Restrict `.env` on every run, test pull requests (`1098ded`)

### Docs

- Add phase 01 transcript and AI log row (`d3d6b68`)
- Update phase 01 transcript with the final session (`1cf9a05`)

## 00-setup

Committed to `main` on 2026-10-07, before the branch workflow existed. No pull request.

### Chores

- Add working agreement, permissions and project skills (`fdf2ea6`)
