# Pinned Terraform and provider versions (ADR-0015). Terraform 1.11 or later is needed for the
# write-only `auth_token_wo` of the cache module and 1.10 for its ephemeral secret read, so no
# secret value enters the state (DEP-R31).
terraform {
  required_version = "= 1.16.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.68.0"
    }
  }
}
