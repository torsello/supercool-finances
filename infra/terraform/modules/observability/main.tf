# Observability (table 1.3 of spec 008, DEP-R32): the CloudWatch log groups of every task and of
# AWS WAF, kept 30 days and encrypted with this module's KMS key, and the one SNS topic every alarm
# of section 1.8 notifies (alarms.tf).

data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region
}

resource "aws_kms_key" "observability" {
  description             = "${var.name}: CloudWatch log groups and the alarm topic"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.key.json
}

resource "aws_kms_alias" "observability" {
  name          = "alias/${var.name}-observability"
  target_key_id = aws_kms_key.observability.key_id
}

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
      identifiers = ["arn:aws:iam::${local.account_id}:root"]
    }
  }

  statement {
    sid       = "CloudWatchLogs"
    actions   = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["logs.${local.region}.amazonaws.com"]
    }

    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:aws:logs:${local.region}:${local.account_id}:log-group:*"]
    }
  }

  statement {
    sid       = "EventBridgeToTheEncryptedTopic"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey*"]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
  }

  statement {
    sid       = "CloudWatchAlarmsToTheEncryptedTopic"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey*"]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
  }
}

# One log group per task definition, each its own resource so the policies can tell them apart.
resource "aws_cloudwatch_log_group" "api" {
  #checkov:skip=CKV_AWS_338:DEP-R32 keeps the logs 30 days, a setting ADR-0014 adopts from section 1.7 of spec 008.
  name              = "/${var.name}/api"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.observability.arn
}

resource "aws_cloudwatch_log_group" "migrate" {
  #checkov:skip=CKV_AWS_338:DEP-R32 keeps the logs 30 days, a setting ADR-0014 adopts from section 1.7 of spec 008.
  name              = "/${var.name}/migrate"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.observability.arn
}

resource "aws_cloudwatch_log_group" "bootstrap" {
  #checkov:skip=CKV_AWS_338:DEP-R32 keeps the logs 30 days, a setting ADR-0014 adopts from section 1.7 of spec 008.
  name              = "/${var.name}/bootstrap"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.observability.arn
}

resource "aws_cloudwatch_log_group" "cleanup" {
  #checkov:skip=CKV_AWS_338:DEP-R32 keeps the logs 30 days, a setting ADR-0014 adopts from section 1.7 of spec 008.
  name              = "/${var.name}/idempotency-cleanup"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.observability.arn
}

# AWS WAF requires the aws-waf-logs- prefix.
resource "aws_cloudwatch_log_group" "waf" {
  #checkov:skip=CKV_AWS_338:DEP-R32 keeps the logs 30 days, a setting ADR-0014 adopts from section 1.7 of spec 008.
  name              = "aws-waf-logs-${var.name}"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.observability.arn
}

# AWS WAF's logs (section 1.7 of spec 008).
resource "aws_wafv2_web_acl_logging_configuration" "this" {
  resource_arn            = var.waf_web_acl_arn
  log_destination_configs = [aws_cloudwatch_log_group.waf.arn]

  # Never log a credential or a key (SEC-R22).
  redacted_fields {
    single_header {
      name = "authorization"
    }
  }

  redacted_fields {
    single_header {
      name = "cookie"
    }
  }

  redacted_fields {
    single_header {
      name = "idempotency-key"
    }
  }
}

resource "aws_sns_topic" "alarms" {
  name              = "${var.name}-alarms"
  kms_master_key_id = aws_kms_key.observability.arn
}

resource "aws_sns_topic_policy" "alarms" {
  arn    = aws_sns_topic.alarms.arn
  policy = data.aws_iam_policy_document.topic.json
}

data "aws_iam_policy_document" "topic" {
  statement {
    sid       = "RdsStorageEvents"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alarms.arn]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.rds_storage.arn]
    }
  }

  statement {
    sid       = "CloudWatchAlarms"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alarms.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}
