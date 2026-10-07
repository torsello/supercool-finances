# NNN · Capability name

- **Status:** Draft | Approved | Implemented
- **ID prefix:** PFX
- **Related ADRs:** ADR-NNNN, ...
- **Depends on specs:** NNN-name, ...

## 1. Context and goal

What this capability is for, who uses it, and what problem it solves. One or two short paragraphs.

## 2. Requirements

| ID | Requirement (EARS) |
|---|---|
| PFX-R01 | WHEN <trigger> THE SYSTEM SHALL <response>. |
| PFX-R02 | IF <unwanted condition> THEN THE SYSTEM SHALL <response>. |
| PFX-R03 | THE SYSTEM SHALL <always-true behaviour>. |

## 3. Acceptance criteria

### PFX-AC01 · Short title

- **Level:** unit | integration | e2e | ci
- **Covers:** PFX-R01
- **Given** <initial state with concrete values, e.g. a customer account with balance "1050" EUR owned by user A>
- **When** <action, e.g. user A posts a withdrawal of "500" EUR with Idempotency-Key k1>
- **Then** <observable outcome, e.g. 201, balance "550" EUR, one balanced ledger transaction>

> Only ACs with level `ci` add a line `- **Verified by:** <command or CI job>`.

## 4. Error catalogue

| Condition | HTTP | Problem type | Stored for idempotent replay |
|---|---|---|---|
| <condition> | 4xx | /problems/<slug> | yes / no |

## 5. Invariants

- <Property that must hold before and after every operation of this capability.>

## 6. Out of scope

- <What this spec deliberately does not cover.>

## 7. Open questions

| Question | Recommended answer | Decided by |
|---|---|---|
| <question> | <recommendation> | <owner / pending> |
