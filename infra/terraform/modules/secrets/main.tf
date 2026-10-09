# Secrets (table 1.3 of spec 008, DEP-R31): the Secrets Manager secrets of the service and the KMS
# key that encrypts them and RDS's master secret. Terraform creates no secret version and no
# random password: an operator or the pipeline sets every value with
# `aws secretsmanager put-secret-value` before the rest of the configuration is applied, so no
# secret value enters the code or the state (section 1.7, docs/deployment/aws.md). One resource
# per secret, so the policies of infra/policies/ can tell them apart (DEP-AC22).

data "aws_caller_identity" "current" {}

resource "aws_kms_key" "secrets" {
  description             = "${var.name}: Secrets Manager secrets and RDS's master secret"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.key.json
}

resource "aws_kms_alias" "secrets" {
  name          = "alias/${var.name}-secrets"
  target_key_id = aws_kms_key.secrets.key_id
}

# The account administers the key; Secrets Manager, RDS and the task execution roles use it
# through IAM policies of their own and the services' grants.
data "aws_iam_policy_document" "key" {
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

resource "aws_secretsmanager_secret" "jwt_secret" {
  #checkov:skip=CKV2_AWS_57:Values are set out of band and never by Terraform (DEP-R31, ADR-0015); a rotation is a new value put by an operator, applied to the roles by the bootstrap task (section 1.7 of spec 008).
  name                    = "${var.name}/jwt-secret"
  description             = "JWT_SECRET: at least 32 bytes (AUT-R18), plain text."
  kms_key_id              = aws_kms_key.secrets.arn
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret" "cursor_secret" {
  #checkov:skip=CKV2_AWS_57:Values are set out of band and never by Terraform (DEP-R31, ADR-0015); a rotation is a new value put by an operator, applied to the roles by the bootstrap task (section 1.7 of spec 008).
  name                    = "${var.name}/cursor-secret"
  description             = "CURSOR_SECRET: at least 32 bytes, different from JWT_SECRET, plain text."
  kms_key_id              = aws_kms_key.secrets.arn
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret" "db_owner" {
  #checkov:skip=CKV2_AWS_57:Values are set out of band and never by Terraform (DEP-R31, ADR-0015); a rotation is a new value put by an operator, applied to the roles by the bootstrap task (section 1.7 of spec 008).
  name                    = "${var.name}/db-owner"
  description             = "The owner role scf_owner: JSON with username and password (printable ASCII)."
  kms_key_id              = aws_kms_key.secrets.arn
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret" "db_runtime" {
  #checkov:skip=CKV2_AWS_57:Values are set out of band and never by Terraform (DEP-R31, ADR-0015); a rotation is a new value put by an operator, applied to the roles by the bootstrap task (section 1.7 of spec 008).
  name                    = "${var.name}/db-runtime"
  description             = "The runtime role scf_app: JSON with username and password (printable ASCII), read by RDS Proxy."
  kms_key_id              = aws_kms_key.secrets.arn
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret" "redis" {
  #checkov:skip=CKV2_AWS_57:Values are set out of band and never by Terraform (DEP-R31, ADR-0015); a rotation is a new value put by an operator, applied to the roles by the bootstrap task (section 1.7 of spec 008).
  name                    = "${var.name}/redis"
  description             = "Redis: JSON with auth_token and url (rediss://:<auth_token>@<primary endpoint>:6379)."
  kms_key_id              = aws_kms_key.secrets.arn
  recovery_window_in_days = 7
}
