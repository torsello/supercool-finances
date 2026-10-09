# Least privilege: one execution role per task definition, which may pull the image, write to that
# task's log group and read only that task's secrets; and one task role with no permission at all,
# since the service calls no AWS API.

locals {
  # The secrets each task definition reads, and nothing else (DEP-AC19, DEP-AC22, DEP-AC28).
  execution_secrets = {
    api = [
      var.jwt_secret_arn,
      var.cursor_secret_arn,
      var.db_runtime_secret_arn,
      var.redis_secret_arn,
    ]
    migrate   = [var.db_owner_secret_arn]
    bootstrap = [var.master_secret_arn, var.db_owner_secret_arn, var.db_runtime_secret_arn]
    cleanup   = [var.db_runtime_secret_arn]
  }

  # The log groups the observability module creates, named as the task definitions name them.
  log_group_prefix = "arn:aws:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:/${var.name}"
  log_group_arns = {
    api       = "${local.log_group_prefix}/api"
    migrate   = "${local.log_group_prefix}/migrate"
    bootstrap = "${local.log_group_prefix}/bootstrap"
    cleanup   = "${local.log_group_prefix}/idempotency-cleanup"
  }
}

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "task" {
  name               = "${var.name}-task"
  description        = "The tasks' own role: no permission, since the service calls no AWS API."
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role" "execution" {
  for_each = local.execution_secrets

  name               = "${var.name}-${each.key}-execution"
  description        = "ECS pulls the image, writes the logs and reads the secrets of ${each.key}."
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "execution" {
  for_each = local.execution_secrets

  statement {
    sid       = "EcrToken"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid       = "EcrPull"
    actions   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
    resources = [aws_ecr_repository.this.arn]
  }

  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${local.log_group_arns[each.key]}:*"]
  }

  statement {
    sid       = "Secrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = each.value
  }

  statement {
    sid       = "SecretsKey"
    actions   = ["kms:Decrypt"]
    resources = [var.secrets_kms_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${data.aws_region.current.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "execution" {
  for_each = local.execution_secrets

  name   = "execution"
  role   = aws_iam_role.execution[each.key].id
  policy = data.aws_iam_policy_document.execution[each.key].json
}
