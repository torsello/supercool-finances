# AI usage log

The challenge asks for every prompt used with an AI along with every response. This folder holds them.

- [`transcripts/`](transcripts/) has one plain-text export per work session, in order. Long phases are split into parts named `NN-name-part1.txt`, `NN-name-part2.txt`, ...
- The rules the AI follows are in [`AGENTS.md`](../../AGENTS.md), and the project skills are in [`.claude/skills/`](../../.claude/skills/).

## How a session works

1. A fresh session per phase, so each one starts from the repository and `AGENTS.md`, not from earlier chat history.
2. I write the prompts; the AI implements.
3. I review the output and ask for changes.
4. `/audit` runs an independent, read-only review in a separate agent that has not seen the conversation.
5. `/export` saves the transcript to `transcripts/`.
6. `/ship` runs the quality gates, commits and pushes the phase branch. When a phase closes, it also opens the pull request to `main`, which I merge once CI is green.

## Sessions

| # | Date | Transcript | Summary |
|---|---|---|---|
| pre | 2026-10-07 | [00-planning.md](00-planning.md) | Summary of the planning chat before the repository: risks, key decisions and dry runs of the setup prompts. |
| 00 | 2026-10-07 | [00-setup.txt](transcripts/00-setup.txt) | Repository setup: problem statement, AGENTS.md, CLAUDE.md, Claude Code permissions, the spec, adr, audit and ship skills, and this log. |
| 01 | 2026-10-07 | [01-bootstrap.txt](transcripts/01-bootstrap.txt) | Bootstrap: Node 24 and strict TypeScript toolchain, Fastify walking skeleton, Postgres and Redis in Docker Compose, env:sync, GitHub Actions CI with a secret scan, the phase branch and pull request workflow, and four audit rounds. |
| 02 part 1 | 2026-10-07 | [02-specs-part1.txt](transcripts/02-specs-part1.txt) | Specs, part 1: the spec scaffolding and the traceability gate (`npm run trace`), specs 000-overview and 001-accounts, four audit rounds and their fixes. |
| 02 part 2 | 2026-10-07 | [02-specs-part2.txt](transcripts/02-specs-part2.txt) | Specs, part 2: specs 002-ledger and 003-money-movements with the owner's decisions, two audit rounds and their fixes, including a stricter traceability gate, and `/ship` of both specs. |
| 02 part 3 | 2026-10-07 | [02-specs-part3.txt](transcripts/02-specs-part3.txt) | Specs, part 3: specs 004-reversals and 005-idempotency with the owner's decisions, an audit round and its fixes, including a traceability gate that no longer counts a CI step whose failure is ignored with `||`, and `/ship` of both specs. |
| 02 part 4 | 2026-10-07 | [02-specs-part4.txt](transcripts/02-specs-part4.txt) | Specs, part 4: specs 006-auth, 007-security-ops and 008-deployment with the owner's decisions, an audit round and its fixes, including a traceability gate that no longer counts a CI script feeding a pipe without pipefail or a `&&` list before the last line of its block, and `/ship` of the three specs. |
| 02 part 5 | 2026-10-07 | [02-specs-part5.txt](transcripts/02-specs-part5.txt) | Specs, part 5: cross-spec review of specs 000-008, the owner's answers to every open question folded into the specs as rules, eight overview ACs retired, all specs set to Approved, an audit round and its fixes, including a traceability gate that accepts a CI script only as the whole command of a step, and `/ship` closing the phase. |
| 03 | 2026-10-08 | [03-adrs.txt](transcripts/03-adrs.txt) | ADRs: twenty decisions 0001-0020 with the owner's reasoning, alternatives and consequences, the ADR index, links to and from every spec, the AWS RDS Proxy pinning source checked, and three audit rounds and their fixes. |
| 04 | 2026-10-08 | [04-plans.txt](transcripts/04-plans.txt) | Plans: plan.md and tasks.md for specs 000-008 with every AC placed in a phase and a test file, owner-approved spec fixes, ADR-0021 (statement-timeout function) and ADR-0022 (request timeout: answer first, then roll back), the `yaml` dev dependency, and seven audit rounds and their fixes. |
| 05 | 2026-10-08 | [05-schema.txt](transcripts/05-schema.txt) | Schema: the owner and runtime roles, eight SQL migrations (role settings, session functions, accounts, ledger with deferred and append-only triggers, settlement accounts, audit records, idempotency keys, readiness grant), the Kysely instance with exact int8 and numeric strings, test helpers, the database-check ACs, down migrations proven, and an audit round with six fixes.
| 06 part 1 | 2026-10-08 | [06-domain-part1.txt](transcripts/06-domain-part1.txt) | Domain, part 1: the accounts module, the transaction runner and unit of work, module lint rules, the ledger, money movements and reconciliation domain with tests first. |
| 06 part 2 | 2026-10-08 | [06-domain-part2.txt](transcripts/06-domain-part2.txt) | Domain, part 2: the reversals domain (`reversalOf`, reversal rules, the `Reversals` use case with its test seam, the 23505 mapping to `AlreadyReversed`), lock-wait and racing tests, an audit round with four Low fixes, and ADR follow-ups marked done. |
