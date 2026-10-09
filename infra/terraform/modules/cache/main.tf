# Cache (table 1.3 of spec 008, DEP-R30): an ElastiCache Redis 7 replication group across two
# availability zones with automatic failover, encrypted in transit and at rest, with an AUTH token
# from Secrets Manager. The token is read through an ephemeral resource into the write-only
# auth_token_wo, so it never enters the plan or the state (DEP-R31); its secret must hold a value
# before this module is applied (docs/deployment/aws.md).

ephemeral "aws_secretsmanager_secret_version" "redis" {
  secret_id = var.redis_secret_arn
}

resource "aws_kms_key" "cache" {
  description             = "${var.name}: ElastiCache at rest"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.cache_key.json
}

data "aws_caller_identity" "current" {}

# The account administers the key; the service uses it through its own grants.
data "aws_iam_policy_document" "cache_key" {
  #checkov:skip=CKV_AWS_109:A KMS key policy's Resource "*" is the key itself, and the account root statement is AWS's default key policy (ADR-0015).
  #checkov:skip=CKV_AWS_111:A KMS key policy's Resource "*" is the key itself, and the account root statement is AWS's default key policy (ADR-0015).
  #checkov:skip=CKV_AWS_356:A KMS key policy's Resource "*" is the key itself, and the account root statement is AWS's default key policy (ADR-0015).

  statement {
    sid       = "AccountAdministration"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }
}

resource "aws_kms_alias" "cache" {
  name          = "alias/${var.name}-cache"
  target_key_id = aws_kms_key.cache.key_id
}

resource "aws_elasticache_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.isolated_subnet_ids
}

resource "aws_elasticache_replication_group" "this" {
  #checkov:skip=CKV_AWS_31:The AUTH token is set through the write-only auth_token_wo, which this check does not read, with encryption in transit (DEP-R30, DEP-R31, ADR-0015).
  replication_group_id = var.name
  description          = "Per-user rate-limit counters (spec 007)"
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = "cache.t4g.small"
  port                 = 6379

  num_cache_clusters         = var.node_count
  automatic_failover_enabled = true
  multi_az_enabled           = true
  subnet_group_name          = aws_elasticache_subnet_group.this.name
  security_group_ids         = [var.cache_security_group_id]

  at_rest_encryption_enabled = true
  kms_key_id                 = aws_kms_key.cache.arn
  transit_encryption_enabled = true
  transit_encryption_mode    = "required"
  auth_token_wo              = jsondecode(ephemeral.aws_secretsmanager_secret_version.redis.secret_string)["auth_token"]
  auth_token_wo_version      = var.auth_token_version

  snapshot_retention_limit   = 1
  auto_minor_version_upgrade = true
}
