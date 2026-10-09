# Service (table 1.3 of spec 008): the ECR repository, the ECS cluster, the task definitions of the
# service, of the migration task, of the bootstrap task and of the cleanup task (task_definitions.tf),
# the ECS service with its autoscaling, and the EventBridge Scheduler schedule that runs the
# cleanup every hour (schedule.tf). IAM roles are in iam.tf.

data "aws_region" "current" {}

data "aws_caller_identity" "current" {}

resource "aws_ecr_repository" "this" {
  name                 = var.name
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
  }
}

resource "aws_ecs_cluster" "this" {
  name = var.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_service" "api" {
  name             = "${var.name}-api"
  cluster          = aws_ecs_cluster.this.id
  task_definition  = aws_ecs_task_definition.api.arn
  launch_type      = "FARGATE"
  platform_version = "LATEST"
  desired_count    = var.desired_count

  # A rolling deployment that keeps 100% of the desired count healthy (DEP-R27).
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 30
  availability_zone_rebalancing      = "ENABLED"

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # Private subnets in two availability zones, no public IP (DEP-R25, DEP-R27).
  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.tasks_security_group_id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = var.target_group_arn
    container_name   = "api"
    container_port   = var.service_port
  }

  propagate_tags = "SERVICE"

  lifecycle {
    # Autoscaling owns the count between its bounds once the service runs.
    ignore_changes = [desired_count]
  }
}

# 2 to 6 tasks on 60% average CPU (section 1.7 of spec 008).
resource "aws_appautoscaling_target" "api" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.min_count
  max_capacity       = var.max_count
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${var.name}-api-cpu"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  policy_type        = "TargetTrackingScaling"

  target_tracking_scaling_policy_configuration {
    target_value = var.cpu_target_percent

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
