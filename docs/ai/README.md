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
