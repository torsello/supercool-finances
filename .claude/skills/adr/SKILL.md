---
name: adr
description: "Record an architecture decision as docs/adr/NNNN-title.md in MADR format and keep the ADR index up to date. Use whenever a technical decision is made, changed or superseded."
argument-hint: "[title]"
---

Record the decision: $ARGUMENTS

1. Read `AGENTS.md`, `docs/adr/README.md` (create it if missing) and the existing ADRs, to avoid duplicates and pick the next number.
2. Create `docs/adr/NNNN-kebab-title.md` from [template.md](template.md), with today's date.
3. Keep the reasoning the user gave: tighten the wording and add technical detail, but never change the decision or invent a different rationale.
4. List at least two real options, each with honest pros and cons, including the downsides of the chosen one.
5. Consequences include what becomes harder, what must be monitored, and follow-ups.
6. Link the specs the decision affects, and add the ADR to the "Related ADRs" line of each of them.
7. A replaced ADR is marked "Superseded by ADR-NNNN" instead of being edited.
8. Add a row (number, title, status, date) to the table in `docs/adr/README.md`.
