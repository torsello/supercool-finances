# 001 · Gamma

- **Status:** Implemented
- **ID prefix:** ZZC

## 3. Acceptance criteria

### ZZC-AC01 · No test at all

- **Level:** unit

### ZZC-AC02 · CI level with an empty Verified by line

- **Level:** ci
- **Verified by:**

### ZZC-AC03 · CI level without a Verified by line

- **Level:** ci

### ZZC-AC04 · Only skipped, todo and failed tests

- **Level:** unit

### ZZC-AC05 · Proven by a passing unit test

- **Level:** unit

### ZZC-AC06 · An integration AC whose only passing test is in the unit report

- **Level:** integration

### ZZC-AC07 · An e2e AC whose project was not run

- **Level:** e2e

### ZZC-AC08 · One passing and one skipped test

- **Level:** unit

### ZZC-AC09 · A Verified by line naming a script that exists nowhere

- **Level:** ci
- **Verified by:** CI job `ci`, step `npm run zz-absent`

### ZZC-AC10 · A Verified by line naming a script the workflow only mentions in comments

- **Level:** ci
- **Verified by:** CI job `ci`, step `npm run zz-commented`

### ZZC-AC11 · A Verified by line naming a step whose script package.json lacks

- **Level:** ci
- **Verified by:** CI job `ci`, step `npm run zz-step-only`

### ZZC-AC12 · A Verified by line that names no npm run script

- **Level:** ci
- **Verified by:** CI job `terraform` (terraform validate)

### ZZC-AC13 · A step whose failure is ignored with || true

- **Level:** ci
- **Verified by:** CI job `ci`, step `npm run zz-or-true`

### ZZC-AC14 · A step with continue-on-error

- **Level:** ci
- **Verified by:** CI job `ci`, step `npm run zz-continue`

### ZZC-AC15 · A step with if: false

- **Level:** ci
- **Verified by:** CI job `ci`, step `npm run zz-if-false`

### ZZC-AC16 · A step in a job with continue-on-error

- **Level:** ci
- **Verified by:** CI job `optional`, step `npm run zz-job-off`
