---
name: ship
description: "Run the quality gates, commit the current work as a Conventional Commit and push it to the private GitHub repository. Only when the user runs /ship."
disable-model-invocation: true
model: sonnet
effort: low
argument-hint: "[what this checkpoint delivers]"
allowed-tools: Bash(npm run *) Bash(docker compose *) Bash(git add *) Bash(git commit *) Bash(git status *) Bash(git diff *) Bash(git log *) Bash(git restore --staged *) Bash(gitleaks *) Bash(checkov *)
---

Create a checkpoint for: $ARGUMENTS

Current state:

!`git status --short --branch`
!`git diff --stat @{upstream} 2>/dev/null || echo "(nothing pushed yet)"`
!`git log --oneline -5 2>/dev/null || echo "(no commits yet)"`

This skill runs on a smaller, cheaper model on purpose and never changes code: it only verifies, commits and pushes. Run one command per tool call, never chained with `&&`, `;` or `|`, so the allowed tools match without prompting.

Follow these steps in order. If any gate fails, stop at once and report the command and the relevant part of its output, so the fix happens in the main conversation. Never skip, disable or weaken a test, lint rule or check.

## Step 1: gates

1. `npm run check`
2. If `compose.yaml` exists: `npm run infra:up`, then `npm run test:integration`.
3. `npm run trace --if-present`
4. If `infra/terraform` exists: `checkov -d infra/terraform --quiet --compact`. Any finding without a skip comment that references an ADR counts as a failed gate.

## Step 2: docs in sync

- The ACs touched still match code and tests. Spec statuses are not changed here.
- New ADRs are listed in `docs/adr/README.md`.
- If the description starts with "close phase NN" and no file matching `docs/ai/transcripts/NN-*` exists, stop and ask the user to run `/export docs/ai/transcripts/NN-<phase>.txt` first.
- Every transcript in `docs/ai/transcripts/` has a row in `docs/ai/README.md`: phase number plus part if any, date, file link, one-line summary of what the session produced.

## Step 3: stage

Run `git add -A`, then read `git status --short`. Unstage with `git restore --staged` only what must never be committed (`.env`, credentials, `node_modules`, `dist`, `coverage`, large binaries, `*.tfstate`) and warn about it. Everything else is committed, even if it seems unrelated to the description; mention it in the report.

## Step 4: commit

- Subject: `type(scope): summary`, under 72 characters. Types: `feat`, `fix`, `test`, `docs`, `refactor`, `chore`, `ci`, `build`.
- Body: what changed and why in two to five lines, then `Covers: <AC IDs>` when applicable and `Phase: <NN-name>`.
- The last line, after a blank line, is exactly one `Co-authored-by: Claude <noreply@anthropic.com>` trailer (the attribution in `.claude/settings.json`), so GitHub shows Claude as co-author.

## Step 5: secret scan of the commits not pushed yet

`gitleaks git --no-banner --redact --log-opts="@{upstream}..HEAD"` (without `--log-opts` when the branch has no upstream).

- A finding in a transcript: replace the value with `<redacted>`, amend the commit and scan again.
- Any other finding: `git reset --soft HEAD~1`, then stop and report the file and line, without printing the secret.

## Step 6: push

`git push` (the user will be asked to confirm). If the branch has no upstream: `git push -u origin main`. Never force-push.

## Step 7: report, in five lines or less

- Commit hash and subject.
- Gates run and their results.
- AC IDs covered.
- Anything skipped and why.
