# Remote state is configured by whoever applies this configuration, outside this repository
# (DEP-R34, section 6 of spec 008): the block is empty (partial configuration) and holds no bucket,
# key or table name. `npm run infra:validate` runs `terraform init -backend=false`.
#
# Example, with a placeholder bucket and S3's native state locking (no DynamoDB table):
#
#   terraform init \
#     -backend-config="bucket=<state-bucket>" \
#     -backend-config="key=supercool-finances/terraform.tfstate" \
#     -backend-config="region=<region>" \
#     -backend-config="encrypt=true" \
#     -backend-config="use_lockfile=true"
terraform {
  backend "s3" {}
}
