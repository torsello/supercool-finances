# tflint for npm run infra:validate (section 1.7 of spec 008): Terraform's recommended rules and the
# AWS ruleset, pinned by version. Plugins are installed into infra/terraform/.tflint.d/ (ignored).
config {
  call_module_type = "local"
}

plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

plugin "aws" {
  enabled = true
  version = "0.49.0"
  source  = "github.com/terraform-linters/tflint-ruleset-aws"
}
