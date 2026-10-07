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
6. `/ship` runs the quality gates, commits and pushes.

## Sessions

| # | Date | Transcript | Summary |
|---|---|---|---|
| pre | 2026-10-07 | [00-planning.md](00-planning.md) | Summary of the planning chat before the repository: risks, key decisions and dry runs of the setup prompts. |
