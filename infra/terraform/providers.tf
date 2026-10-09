# No credentials here (DEP-R34): whoever applies the configuration supplies them through the
# standard AWS environment or profile.
provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = "supercool-finances"
      ManagedBy = "terraform"
    }
  }
}
