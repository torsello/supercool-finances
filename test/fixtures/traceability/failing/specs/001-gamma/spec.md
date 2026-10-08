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

### ZZC-AC17 · A step whose script feeds a pipe, even with pipefail

- **Level:** ci
- **Verified by:** CI job `ci`, step `npm run zz-piped`

### ZZC-AC18 · A step with another command after the script in a && list

- **Level:** ci
- **Verified by:** CI job `ci`, step `npm run zz-listed-early`

### ZZC-AC19 · A step with an environment assignment before the script

- **Level:** ci
- **Verified by:** CI job `ci`, step `npm run zz-assigned`

### ZZC-AC20 · A step that runs the script as an if condition

- **Level:** ci
- **Verified by:** CI job `ci`, step `npm run zz-condition`

### ZZC-AC21 · A step that only echoes the command

- **Level:** ci
- **Verified by:** CI job `ci`, step `npm run zz-echoed`

### ZZC-AC22 · A step that runs the script in the background

- **Level:** ci
- **Verified by:** CI job `ci`, step `npm run zz-background`

### ZZC-AC23 · A block with another command before the script

- **Level:** ci
- **Verified by:** CI job `ci`, step `npm run zz-second-line`

### ZZC-AC24 · A step with an npm flag before the script name

- **Level:** ci
- **Verified by:** CI job `ci`, step `npm run zz-flagged`, written with `--silent` before the name

### ZZC-AC25 · A step that redirects the script's output

- **Level:** ci
- **Verified by:** CI job `ci`, step `npm run zz-redirected`

### ZZC-AC26 · A step that negates the script's exit code

- **Level:** ci
- **Verified by:** CI job `ci`, step `npm run zz-negated`
