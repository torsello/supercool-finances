# Planning (before the repository)

Before creating the repository, I used Claude in a separate chat to analyse the challenge and prepare how I would run the work. This file is a summary of that session, not a transcript. Every session after it is exported in full in [`transcripts/`](transcripts/).

## What I used the AI for

- Break down the problem statement and list what can go wrong in a service that manages customer money.
- Turn those risks into edge cases, which later became acceptance criteria in the specs.
- Draft the prompt for each work session from my decisions. I reviewed and edited them before using them.
- Check that the toolchain works together before committing to it. A scratch project with TypeScript 6, Fastify 5, Zod 4 and Vitest 5 passed typecheck, lint and tests against a real PostgreSQL 16 and Redis 7, and nginx balanced requests across two replicas.
- Dry-run the setup prompts in an empty repository before starting for real, with Claude Code itself. Those runs surfaced several problems, all fixed before this repository existed:
  - The review and commit skills were first named `/review` and `/checkpoint`, which are built-in Claude Code commands. They became `/audit` and `/ship`.
  - A git command injected into a skill fails when nothing has been pushed yet, and a failing injected command aborts the whole skill. Each one now has a fallback.
  - Claude Code protects the `.claude/` folder, so the session needs explicit approval to write the skills and permission rules.
  - The commit skill chained shell commands, which made the permission rules ask for approval at every step. It now runs one command per call, so only the push asks.
  - The runs also confirmed that `/ship` runs on the smaller model, `/audit` on the larger one, and that every commit credits Claude as co-author.

## What makes this problem hard

These risks drive every decision below:

- **Concurrency.** Two requests on the same account at the same time can overdraw it or lose an update. With several replicas behind a load balancer, in-memory locks or state do not work.
- **Retries.** Clients and load balancers retry on timeouts. Without idempotency, a retried transfer moves the money twice.
- **Precision.** Floats and JavaScript numbers silently lose cents and break above 2^53.
- **Auditability.** A mutable balance column cannot prove where money went.
- **Access.** A customer must never see or move another customer's money.

## Decisions

| Decision | Why |
|---|---|
| TypeScript | It is the language I have the most experience with today. That matters here because I review the code the AI writes, and I catch subtle mistakes faster in a language I know well. Strict typing also helps keep money as `bigint`, never `number`. |
| PostgreSQL, not in-memory storage | Replicas share one durable source of truth. Row locks, unique constraints, check constraints and deferred triggers enforce the invariants in the database itself, as a second line of defence behind the code. |
| One service, modular inside | A transfer updates two accounts and the ledger atomically. Splitting it into services would turn one database transaction into a distributed saga, with no benefit at this scale. |
| Hexagonal architecture with tactical DDD | Money rules are tested on their own, without HTTP or a database. Value objects and aggregates make invalid states impossible to build. The transaction and row locks stay an explicit port, because consistency depends on them. |
| Double-entry, append-only ledger | Every movement is a balanced set of immutable entries, so where money went is provable with a query. Corrections are compensating transactions. |
| Amounts as integer minor units | `bigint` in the domain and digit strings in the API, so no precision is ever lost. |
| Ordered pessimistic locks | Customer accounts are locked in ascending id order, so crossed transfers cannot deadlock. Settlement accounts are never locked, so they cannot become a bottleneck. |
| Idempotency key in the same transaction as the movement | The key and its effect commit or roll back together, so a retry can never duplicate money and no key gets stuck "in progress". |
| Spec-first, with ADRs and tests per acceptance criterion | With an AI writing most of the code, I need a way to check that it built what I decided, not what it assumed. Writing the specs first forces me to decide the behaviour and edge cases up front. Each acceptance criterion has an ID and becomes a test, so if the AI gets something wrong a test fails, instead of a reviewer finding it later. ADRs keep the reasoning behind each decision reviewable. |
| Guardrails for the AI | A working agreement ([`AGENTS.md`](../../AGENTS.md)), permission rules that block destructive commands, an independent review before every push (`/audit`) and gated commits (`/ship`). |
| The right model for each task | Design, specs, code and the independent review run on the most capable model, because that is where quality matters. Committing and pushing is mechanical, so `/ship` runs on a smaller, cheaper model and never changes code: it verifies, commits and pushes, and stops on any failure. |
| Small, frequent pushes to a private repository | Progress is always backed up and reviewable, and every session is exported to this folder. |
| README as an open-source front page, with Mermaid diagrams | A reviewer understands the system without opening other files. Diagrams written as code render on GitHub, live next to the code, and a CI check fails if one stops rendering. |
| Demo panel last, and optional | The correctness of the core, the tests and the documentation come first. A UI only helps if it shows the guarantees, such as invariants holding under parallel load. |

## What I rejected

- **Microservices for accounts, ledger and transfers.** Atomicity across them needs sagas, and money sits in limbo when a step fails.
- **In-memory storage.** It is lost on restart and not shared between replicas.
- **MVC.** In an API, business rules drift into controllers and ORM models, mixed with HTTP and SQL.
- **Event sourcing and CQRS.** The append-only ledger already gives an immutable history at a fraction of the complexity.
- **SERIALIZABLE isolation as the main strategy.** It is correct, but on a busy account it aborts and retries many transactions. Retries on serialization errors stay as a safety net.
- **Serverless hosting for the backend.** It does not fit long-lived database connections and pooling.
- **Hosting a live demo on my own machine.** The link dies whenever the machine is off, and it exposes my home network. A reproducible `docker compose up` is more reliable for a reviewer.

## Where I steered

- I chose TypeScript as the language.
- I wanted the work to start from an empty repository with only the problem statement, so the whole process is visible.
- I asked for a private GitHub repository updated after every step, with one skill that runs the quality gates and pushes, and another that reviews the work independently.
- I raised the internal design question (DDD and hexagonal versus MVC) and settled on hexagonal with tactical DDD.
- I had every setup prompt tested in an empty repository before using it.
- I had the commit-and-push skill run on a smaller model to save tokens, while the review skill always uses the most capable one.
- I wanted every commit to credit Claude as co-author, so the AI's part is visible in the git history.
- I asked for the README to be the front page of a well-documented open-source project. It should explain the architecture with diagrams: how the service, database, cache and load balancer interact, and the key flows such as a transfer, a duplicate request and concurrent transfers.

## How the work runs

One session per phase, prompts in order, an independent review with `/audit`, the transcript exported to `transcripts/`, then a gated commit and push with `/ship`. The phases are listed in [`AGENTS.md`](../../AGENTS.md).
