---
name: ship
description: "Run the quality gates, commit the current work as a Conventional Commit and push the phase branch to the private GitHub repository; when a phase closes, also open its pull request to main. Only when the user runs /ship."
disable-model-invocation: true
model: sonnet
effort: low
argument-hint: "[what this checkpoint delivers]"
allowed-tools: Bash(npm run *) Bash(docker compose *) Bash(git add *) Bash(git commit *) Bash(git status *) Bash(git diff *) Bash(git log *) Bash(git restore --staged *) Bash(gitleaks *) Bash(checkov *) Bash(gh pr create *) Bash(gh pr view *)
---

Create a checkpoint for: $ARGUMENTS

Current state:

!`git status --short --branch`
!`git diff --stat @{upstream} 2>/dev/null || echo "(nothing pushed yet)"`
!`git log --oneline -5 2>/dev/null || echo "(no commits yet)"`

This skill runs on a smaller, cheaper model on purpose and never changes code: it only verifies, commits and pushes. Run one command per tool call, never chained with `&&`, `;` or `|`, so the allowed tools match without prompting.

Follow these steps in order. If any gate fails, stop at once and report the command and the relevant part of its output, so the fix happens in the main conversation. Never skip, disable or weaken a test, lint rule or check.

## Step 1: branch

If the current branch is `main`, stop and ask the user to create the phase branch (`phase/NN-name`, from an up-to-date `main`). Nothing is committed to `main` directly.

## Step 2: gates

1. `npm run check`
2. If `compose.yaml` exists: `npm run infra:up`, then `npm run test:integration`.
3. `npm run trace -- --require unit,integration`, the same gate as CI. It reads the JSON reports that steps 1 and 2 just wrote.
4. If `infra/terraform` exists: `checkov -d infra/terraform --quiet --compact`. Any finding without a skip comment that references an ADR counts as a failed gate.

## Step 3: docs in sync

- The ACs touched still match code and tests. Spec statuses are not changed here.
- New ADRs are listed in `docs/adr/README.md`.
- If the description starts with "close phase NN" and no file matching `docs/ai/transcripts/NN-*` exists, stop and ask the user to run `/export docs/ai/transcripts/NN-<phase>.txt` first.
- Every transcript in `docs/ai/transcripts/` has a row in `docs/ai/README.md`: phase number plus part if any, date, file link, one-line summary of what the session produced.

## Step 4: stage

Run `git add -A`, then read `git status --short`. Unstage with `git restore --staged` only what must never be committed (`.env`, credentials, `node_modules`, `dist`, `coverage`, large binaries, `*.tfstate`) and warn about it. Everything else is committed, even if it seems unrelated to the description; mention it in the report.

## Step 5: commit

- Subject: `type(scope): summary`, under 72 characters. Types: `feat`, `fix`, `test`, `docs`, `refactor`, `chore`, `ci`, `build`.
- Body: what changed and why in two to five lines, then `Covers: <AC IDs>` when applicable and `Phase: <NN-name>`.
- The last line, after a blank line, is exactly one `Co-authored-by: Claude <noreply@anthropic.com>` trailer (the attribution in `.claude/settings.json`), so GitHub shows Claude as co-author.

## Step 6: secret scan of the branch

`gitleaks git --no-banner --redact --log-opts="origin/main..HEAD"`, which covers every commit of the branch that is not on `main` yet.

- A finding in a commit that is already pushed (the branch has an upstream and `git log --oneline @{upstream}..HEAD` does not list that commit): stop and report the commit, file and line, without printing the secret. Never rewrite pushed history: the user decides what to do.
- A finding in a commit that is not the new commit and is not on the upstream yet, or any such finding on a branch with no upstream: stop and report the commit, file and line, without printing the secret, and do not push.
- A finding in a transcript in the new commit: replace the value with `<redacted>`, amend the commit and scan again.
- Any other finding in the new commit: `git reset --soft HEAD~1`, then stop and report the file and line, without printing the secret.

## Step 7: push

`git push -u origin HEAD` (the user will be asked to confirm). Never force-push.

## Step 8: pull request, only when the description starts with "close phase NN"

1. `gh pr view` on the branch. If a pull request already exists, show its URL and do not create another.
2. Otherwise pass the body inline with a quoted heredoc, so no file is written and `Bash(gh pr create *)` still matches:

   ```
   gh pr create --base main --title "Phase NN-name: <one-line summary>" --body-file - <<'EOF'
   ...
   EOF
   ```

   The body lists:
   - what the phase delivered;
   - the AC IDs covered;
   - the transcript files of the phase in `docs/ai/transcripts/`;
   - the verdict of the last `/audit`, if it appears in this conversation.
3. Never merge it: the user merges it after CI passes.

## Step 9: report, in five lines or less

- Commit hash and subject.
- Gates run and their results.
- AC IDs covered.
- Pull request URL, when one was opened or already existed.
- Anything skipped and why.
