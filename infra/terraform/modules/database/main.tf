# Database (table 1.3 of spec 008, DEP-R29): RDS PostgreSQL 16 in one Multi-AZ instance, behind
# RDS Proxy, through which alone the service and the cleanup task connect.
#
# RDS Proxy and pinning: ADR-0019. The service never sends SET, RESET, DISCARD or a direct
# set_config (SEC-R30); per-transaction lock and statement timeouts go through the SQL functions
# app.set_lock_timeout and app.set_statement_timeout, because the AWS page "Avoiding pinning an
# RDS Proxy" (https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-pinning.html,
# re-read on 2026-10-09) says that calling stored functions does not pin, while SET and set_config
# do. The migration and bootstrap tasks connect to the instance directly instead, since
# node-pg-migrate's session advisory lock would pin their connection (section 1.7 of spec 008),
# and the alarm on DatabaseConnectionsCurrentlySessionPinned watches the rest (section 1.8).

resource "aws_kms_key" "database" {
  description             = "${var.name}: RDS storage and Performance Insights"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.database_key.json
}

data "aws_caller_identity" "current" {}

# The account administers the key; the service uses it through its own grants.
data "aws_iam_policy_document" "database_key" {
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

resource "aws_kms_alias" "database" {
  name          = "alias/${var.name}-database"
  target_key_id = aws_kms_key.database.key_id
}

resource "aws_db_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.isolated_subnet_ids
}

resource "aws_db_parameter_group" "this" {
  name   = "${var.name}-postgres16"
  family = "postgres16"

  # TLS required on every connection (DEP-R29).
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  # The connection budget of SEC-R36, a deployment's surge included: 6 tasks x 200% = 12 tasks,
  # 12 x (DB_POOL_MAX 10 + 1) + 10 = 142 of the 197 usable connections (section 1.9 of spec 007).
  # db.t4g.medium's default is far higher; RDS Proxy keeps at most 90% of it (DEP-R29). A static
  # parameter: it takes effect at the next reboot.
  parameter {
    name         = "max_connections"
    value        = tostring(var.max_connections)
    apply_method = "pending-reboot"
  }

  # No statement log holds a bind parameter, such as the bootstrap's password verifiers
  # (section 1.7 of spec 008).
  parameter {
    name  = "log_parameter_max_length"
    value = "0"
  }
}

resource "aws_db_instance" "this" {
  #checkov:skip=CKV_AWS_161:The roles authenticate with passwords from Secrets Manager, which RDS Proxy reads (ADR-0018, ADR-0019); IAM database authentication is not used.
  #checkov:skip=CKV_AWS_118:Performance Insights and the CloudWatch alarms of section 1.8 of spec 008 monitor the instance; enhanced monitoring is not among its settings (ADR-0014).
  #checkov:skip=CKV_AWS_129:Exporting the PostgreSQL logs is not among the settings of section 1.7 of spec 008; they stay on the instance (ADR-0014).
  identifier     = var.name
  engine         = "postgres"
  engine_version = "16"
  instance_class = "db.t4g.medium"

  allocated_storage     = 20
  max_allocated_storage = var.max_allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.database.arn

  db_name                       = var.database_name
  username                      = var.master_username
  manage_master_user_password   = true
  master_user_secret_kms_key_id = var.secrets_kms_key_arn

  multi_az               = true
  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [var.database_security_group_id]
  publicly_accessible    = false
  parameter_group_name   = aws_db_parameter_group.this.name
  ca_cert_identifier     = "rds-ca-rsa2048-g1"

  backup_retention_period    = 7
  copy_tags_to_snapshot      = true
  deletion_protection        = true
  skip_final_snapshot        = false
  final_snapshot_identifier  = "${var.name}-final"
  auto_minor_version_upgrade = true

  performance_insights_enabled    = true
  performance_insights_kms_key_id = aws_kms_key.database.arn
}

# RDS Proxy reads the runtime role's secret only: the service and the cleanup task are its only
# clients (DEP-R29).
resource "aws_iam_role" "proxy" {
  name               = "${var.name}-rds-proxy"
  assume_role_policy = data.aws_iam_policy_document.proxy_assume.json
}

data "aws_iam_policy_document" "proxy_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "proxy" {
  name   = "runtime-role-secret"
  role   = aws_iam_role.proxy.id
  policy = data.aws_iam_policy_document.proxy.json
}

data "aws_iam_policy_document" "proxy" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.runtime_secret_arn]
  }

  statement {
    actions   = ["kms:Decrypt"]
    resources = [var.secrets_kms_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${data.aws_region.current.region}.amazonaws.com"]
    }
  }
}

data "aws_region" "current" {}

resource "aws_db_proxy" "this" {
  name                   = var.name
  engine_family          = "POSTGRESQL"
  require_tls            = true
  role_arn               = aws_iam_role.proxy.arn
  vpc_subnet_ids         = var.isolated_subnet_ids
  vpc_security_group_ids = [var.proxy_security_group_id]

  auth {
    auth_scheme               = "SECRETS"
    secret_arn                = var.runtime_secret_arn
    iam_auth                  = "DISABLED"
    client_password_auth_type = "POSTGRES_SCRAM_SHA_256" #checkov:skip=CKV_SECRET_6:POSTGRES_SCRAM_SHA_256 is the name of RDS Proxy's client authentication type, not a secret (ADR-0019).
    description               = "The runtime role scf_app"
  }
}

resource "aws_db_proxy_default_target_group" "this" {
  db_proxy_name = aws_db_proxy.this.name

  connection_pool_config {
    # At most 90% of max_connections, leaving the rest to the migration and bootstrap tasks,
    # which connect to the instance directly (DEP-R29).
    max_connections_percent      = var.proxy_max_connections_percent
    max_idle_connections_percent = 50
    # Seconds a statement waits for a database connection before the proxy answers SQLSTATE
    # 08000, which the service answers 503 (SEC-R49): well inside REQUEST_TIMEOUT_MS, beside the
    # lock and pool waits, instead of AWS's default of 120 s (section 1.1 of spec 007).
    connection_borrow_timeout = 5
  }
}

resource "aws_db_proxy_target" "this" {
  db_proxy_name          = aws_db_proxy.this.name
  target_group_name      = aws_db_proxy_default_target_group.this.name
  db_instance_identifier = aws_db_instance.this.identifier
}
