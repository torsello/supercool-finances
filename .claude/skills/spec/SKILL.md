---
name: spec
description: "Write or update a capability spec at specs/NNN-name/spec.md using the project template (EARS requirements, Given/When/Then acceptance criteria with IDs, error catalogue). Use whenever a spec is requested or needs changes."
argument-hint: "[NNN-name] [ID prefix]"
---

Write or update the spec requested: $ARGUMENTS

1. Read `AGENTS.md`, `specs/README.md` and every existing `specs/*/spec.md`, so the glossary, ID prefixes, error types and wording stay consistent across specs.
2. Create or edit `specs/<NNN-name>/spec.md` following [template.md](template.md) exactly. New specs start with `Status: Draft`.
3. Requirements use EARS notation, one behaviour per line, with IDs `<PFX>-R01`, `<PFX>-R02`, ...
4. Acceptance criteria:
   - One per behaviour and one per edge case the user listed, with IDs `<PFX>-AC01`, ...
   - Given/When/Then with concrete values: amounts as digit strings in minor units, explicit currencies, explicit roles.
   - Each one states its test level: `unit`, `integration` or `e2e`.
   - Only when no test can prove an AC (for example Terraform validated in CI), it uses level `ci` plus a line `- **Verified by:** <command or CI job>`.
   - No vague words such as "properly", "correctly" or "gracefully".
5. Error catalogue: condition, HTTP status, problem type (`/problems/<slug>`), and whether the response is stored for idempotent replay.
6. Never invent business rules. Anything not stated by the user, `AGENTS.md` or an ADR goes to "Open questions" with a recommended answer.
7. Never write code in this step.
8. If an ID is renamed or removed, search tests and docs for it and list what must change.
9. Finish with the number of requirements and ACs, the open questions, and anything that conflicts with another spec.
