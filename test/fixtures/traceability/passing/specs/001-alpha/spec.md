# 001 · Alpha

- **Status:** Implemented
- **ID prefix:** ZZA

## 3. Acceptance criteria

### ZZA-AC01 · Proven by a passing unit test

- **Level:** unit

### ZZA-AC02 · Proven by a CI job

- **Level:** ci
- **Verified by:** CI job `terraform`, step `npm run zz-terraform-validate`

### ZZA-AC03 · Proven by a passing integration test

- **Level:** integration

### ZZA-AC04 · Proven by a table-driven unit test

- **Level:** unit

### ZZA-AC05 · Proven by CI steps that run package scripts

- **Level:** ci
- **Verified by:** CI job `ci`, step `npm run zz-check`, run after `npm run zz:prepare`.

### ZZA-AC06 · Proven by a piped step with pipefail and a && list on the last line

- **Level:** ci
- **Verified by:** CI job `ci`, steps `npm run zz-piped` and `npm run zz-listed`

## 4. Examples

```markdown
### ZZA-AC99 · Inside a code fence, so not an AC
```
