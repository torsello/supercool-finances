# Custom checkov policies

The YAML policies `npm run infra:validate` runs with checkov against `infra/terraform/` (section 1.7
of spec 008). Each policy's id names the acceptance criterion it checks, so a failure points to the
AC: `SCF_DEP_AC16_*` for DEP-AC16, `SCF_SEC_AC35_*` for SEC-AC35, and so on.

How checkov sees the Terraform, which the policies rely on:

- A reference to another module's resource is rendered as that resource's address, for example
  `aws_security_group.alb.id`, so the policies compare addresses.
- A container definition is rendered as data only when it is a `local` object passed to
  `jsonencode()` with no comment inside it; the policies match its string form with regular
  expressions. Checkov writes `=` inside such strings as `:`, so the patterns accept both.
- A policy that must prove that something exists uses a connection with the operator `one_exists`:
  the resource passes when at least one connected resource meets the attribute conditions.
- A value checkov cannot render makes the policy fail, never pass silently.
