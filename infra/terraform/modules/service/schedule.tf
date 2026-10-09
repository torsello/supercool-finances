# The idempotency cleanup every hour (DEP-R37): an EventBridge Scheduler schedule that runs the
# cleanup task definition on Fargate in the private subnets without a public IP. Its role may run
# that task definition only, on this cluster, and pass only its roles (DEP-AC26). No other task
# is scheduled.

resource "aws_scheduler_schedule" "cleanup" {
  #checkov:skip=CKV_AWS_297:The schedule carries no input, only the cleanup task definition's ARN, so AWS's own key encrypts nothing sensitive (ADR-0014).
  name                = "${var.name}-idempotency-cleanup"
  description         = "Deletes expired idempotency keys (IDM-R22, DEP-R37)."
  schedule_expression = "rate(1 hour)"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_ecs_cluster.this.arn
    role_arn = aws_iam_role.scheduler.arn

    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.cleanup.arn
      launch_type         = "FARGATE"
      platform_version    = "LATEST"
      task_count          = 1

      network_configuration {
        subnets          = var.private_subnet_ids
        security_groups  = [var.tasks_security_group_id]
        assign_public_ip = false
      }
    }

    retry_policy {
      maximum_retry_attempts       = 2
      maximum_event_age_in_seconds = 900
    }
  }
}

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${var.name}-cleanup-scheduler"
  description        = "Runs the idempotency cleanup task definition, and nothing else."
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

# Written with jsonencode() rather than a policy document data source, so checkov reads it
# (SCF_DEP_AC26_SCHEDULER_ROLE).
resource "aws_iam_role_policy" "scheduler" {
  name = "run-cleanup"
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "RunTheCleanupOnly"
        Effect    = "Allow"
        Action    = "ecs:RunTask"
        Resource  = "${aws_ecs_task_definition.cleanup.arn_without_revision}:*"
        Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.this.arn } }
      },
      {
        Sid       = "PassTheCleanupRolesOnly"
        Effect    = "Allow"
        Action    = "iam:PassRole"
        Resource  = [aws_iam_role.execution["cleanup"].arn, aws_iam_role.task.arn]
        Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } }
      },
    ]
  })
}
