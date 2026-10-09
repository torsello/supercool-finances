# ADR-0015: Terraform for infrastructure as code

- **Status:** Accepted
- **Date:** 2026-10-08
- **Related specs:** 008-deployment

## Context and problem

The AWS architecture of ADR-0014 must be expressed as infrastructure as code, reviewed and checked in CI, but never applied from this repository (DEP-R24, DEP-R33, DEP-R34). Reviewers of the challenge must be able to read it. The question is which tool expresses it.

## Decision drivers

- Readable by most reviewers.
- Static checks in CI without AWS credentials.
- Reusable modules matching the components of the architecture (table 1.3 of spec 008).
- No secret value in code or state (DEP-R31).
- Runs with only Docker on a developer machine.

## Considered options

### Option A: Terraform

- **Pros:**
  - Widely known; HCL is declarative and reads close to the resources it creates.
  - A plan and review workflow for whoever applies it, outside this repository.
  - Reusable modules (`network`, `edge`, `service`, `database`, `cache`, `secrets`, `observability`).
  - Mature static tooling: `terraform fmt` and `validate`, `tflint` with the AWS ruleset, and `checkov` with custom policies, runnable from pinned Docker images through `npm run infra:validate`.
- **Cons:**
  - Another language (HCL) beside TypeScript.
  - State must be stored and locked somewhere when it is applied (not in this repository).
  - Licence change to BSL in 2023; OpenTofu is the open fork if that matters to an adopter.

### Option B: AWS CDK

- **Pros:**
  - TypeScript, the same language as the service; high-level constructs.
- **Cons:**
  - Synthesizes CloudFormation, so reviewers read generated templates or imperative code; harder to read for most reviewers than HCL.
  - AWS only.

### Option C: Pulumi

- **Pros:**
  - TypeScript with real programming constructs; multi-cloud.
- **Cons:**
  - Smaller audience among reviewers; imperative code can hide what is created.

## Decision

Chosen option: **Option A**, because Terraform is widely known, has a plan and review workflow and reusable modules, and is statically scanned with `tflint` and `checkov` in CI through `npm run infra:validate`, which runs pinned Docker images. Secrets are created without values, so none enters the state (section 1.7 of spec 008). AWS CDK and Pulumi would let the infrastructure be written in TypeScript, but Terraform is easier for most reviewers to read. The code is validated and scanned in CI, never applied from this repository (DEP-R34).

## Consequences

### Positive

- Every resource of the architecture is in one readable root configuration with one module per component (DEP-R24).
- Security policies (only the ALB public, TLS, encryption, no secret values) are checked on every CI run (DEP-AC16 to DEP-AC23).

### Negative / costs

- The Terraform is never applied here, so errors only a real `apply` finds (quotas, naming collisions, provider runtime checks) stay undetected.
- Pinned tool images need updating.

### To monitor

- `npm run infra:validate` in CI: any finding fails the build (DEP-R33).

### Follow-ups

- Phase 12-infra: the modules, the policies in `infra/policies/`, `npm run infra:validate` and its CI step.
  - Done in phase 12-infra on 2026-10-09.
