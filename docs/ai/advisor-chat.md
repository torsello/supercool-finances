# Advisor chat (summary)

Besides Claude Code, I used one separate Claude conversation on claude.ai as an advisor for the whole project. Its first part, before the repository existed, is summarised in [00-planning.md](00-planning.md); this file summarises the rest. It is a summary, not a transcript: the conversation is long, mostly in Spanish, and includes talk unrelated to the project. The full conversation is available on request.

## What I used it for

- Drafting the prompt for each phase from my decisions. Every prompt as I sent it is in the Claude Code transcripts.
- Reviewing each result before I approved it: reading the changed files in the repository, checking claims against the code, and sometimes running the stack itself, for example the Postman collection against two replicas behind nginx.
- Triaging every /audit report: what blocks shipping (High or Critical, or Medium on money, concurrency, idempotency or security) and what is fixed before shipping without a new audit.
- Laying out the options when Claude Code asked me to choose, with a recommendation; I chose.
- Reading CI logs to find the cause of a failure before asking for a fix.
- Keeping a phase-by-phase plan up to date.

## Decisions taken there

The chat proposed options; I decided. The main ones, each recorded in the specs or ADRs:

- Scope: build the opt-in dashboards and error reporting; skip the demo UI.
- Supply chain: remove npm from the runtime image after trivy found vulnerabilities in it; run trivy from an image pinned by digest; one CI run per pull request, on pinned runners.
- Connection budget: count the deployment's surge, with max_connections 200 on RDS.
- Edge: AWS WAF answers 429 with a JSON body instead of 403.
- Database failures: RDS Proxy's borrow timeout of 5 s answers 503; a connection lost during a request, COMMIT included, answers 503 instead of 500, so a retry with the same key reveals the outcome.
- CI load test at 100 requests per second, after the logs showed a two-CPU runner saturating at 200.
- Error reporting: an own client with no SDK, an https DSN except on loopback, and opt-in only through a separate Compose file.
- One branch and pull request per phase, even when merging two phases would have been faster.

## Where the advice was wrong

Some advice was wrong and the independent audits caught it: answering 408 and 431 with the malformed-request type (changed to a plain 400), and putting gitleaks in the build stage, which made the production image depend on GitHub (moved to a separate tools stage).
