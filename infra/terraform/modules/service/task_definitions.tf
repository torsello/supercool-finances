# Four task definitions on the same image, the one the local stack runs (section 5 of spec 008):
# only the entry point, the variables and the secrets differ. Every container runs as the user
# node (uid 1000) with a read-only root file system (DEP-R19, DEP-R27) and logs to its own
# CloudWatch log group (DEP-R32). Each database password arrives as the secret PGPASSWORD, taken
# from the `password` key of its JSON secret, and each URL, without a password, as a variable
# built here from the endpoint the task must use (section 1.7, DEP-R31).
#
# Each container is a local object passed to jsonencode(), with no comment inside it, and names its
# log group as the observability module does, "/<name>/<task>": the form checkov renders into data
# for the policies of infra/policies/. The execution roles' access to those groups, by ARN, makes
# Terraform create the groups first.

locals {
  image  = "${aws_ecr_repository.this.repository_url}:${var.image_tag}"
  region = data.aws_region.current.region

  # The api container. stopTimeout, 40 s, is above SHUTDOWN_DRAIN_DELAY_MS + SHUTDOWN_TIMEOUT_MS
  # (2 + 30 s), so ECS never kills a task before its shutdown deadline (DEP-R27, section 1.8 of
  # spec 007). healthCheck is liveness, as the image's HEALTHCHECK, which ECS does not read
  # (DEP-R21). DATABASE_URL names RDS Proxy, whose certificate is publicly trusted (DEP-R29).
  # TRUSTED_PROXY_CIDRS names the subnets of the ALB's nodes, the only proxies whose
  # X-Forwarded-For counts.
  api_container = {
    name                   = "api"
    image                  = local.image
    essential              = true
    user                   = "1000"
    readonlyRootFilesystem = true
    portMappings           = [{ containerPort = var.service_port, protocol = "tcp" }]
    stopTimeout            = 40
    healthCheck = {
      command     = ["CMD", "node", "dist/healthcheck.js"]
      interval    = 10
      timeout     = 3
      retries     = 3
      startPeriod = 10
    }
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "PORT", value = tostring(var.service_port) },
      { name = "METRICS_PORT", value = tostring(var.metrics_port) },
      { name = "LOG_LEVEL", value = var.log_level },
      { name = "DATABASE_URL", value = "postgres://scf_app@${var.proxy_endpoint}:5432/${var.database_name}?sslmode=verify-full" },
      { name = "DB_POOL_MAX", value = tostring(var.db_pool_max) },
      { name = "REQUEST_TIMEOUT_MS", value = tostring(var.request_timeout_ms) },
      { name = "SHUTDOWN_DRAIN_DELAY_MS", value = tostring(var.shutdown_drain_delay_ms) },
      { name = "SHUTDOWN_TIMEOUT_MS", value = tostring(var.shutdown_timeout_ms) },
      { name = "JWT_ISSUER", value = var.jwt_issuer },
      { name = "JWT_AUDIENCE", value = var.jwt_audience },
      { name = "TRUSTED_PROXY_CIDRS", value = var.trusted_proxy_cidrs },
    ]
    secrets = [
      { name = "JWT_SECRET", valueFrom = var.jwt_secret_arn },
      { name = "CURSOR_SECRET", valueFrom = var.cursor_secret_arn },
      { name = "PGPASSWORD", valueFrom = "${var.db_runtime_secret_arn}:password::" },
      { name = "REDIS_URL", valueFrom = "${var.redis_secret_arn}:url::" },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = "/${var.name}/api"
        awslogs-region        = local.region
        awslogs-stream-prefix = "api"
      }
    }
  }

  # The migrations, with the owner role, straight to the instance (ADR-0019), verifying its
  # certificate against the RDS CA bundle the image ships (DEP-R28, DEP-R41).
  migrate_container = {
    name                   = "migrate"
    image                  = local.image
    essential              = true
    user                   = "1000"
    readonlyRootFilesystem = true
    entryPoint             = ["node", "dist/cli/migrate.js"]
    command                = ["up"]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "MIGRATION_DATABASE_URL", value = "postgres://scf_owner@${var.instance_address}:5432/${var.database_name}?sslmode=verify-full&sslrootcert=/app/dist/certs/rds-global-bundle.pem" },
    ]
    secrets = [
      { name = "PGPASSWORD", valueFrom = "${var.db_owner_secret_arn}:password::" },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = "/${var.name}/migrate"
        awslogs-region        = local.region
        awslogs-stream-prefix = "migrate"
      }
    }
  }

  # The one-time bootstrap of the roles, as the RDS master user, straight to the instance
  # (DEP-R38 to DEP-R40).
  bootstrap_container = {
    name                   = "bootstrap"
    image                  = local.image
    essential              = true
    user                   = "1000"
    readonlyRootFilesystem = true
    entryPoint             = ["node", "dist/cli/bootstrap-roles.js"]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "BOOTSTRAP_DATABASE_URL", value = "postgres://${var.master_username}@${var.instance_address}:5432/${var.database_name}?sslmode=verify-full&sslrootcert=/app/dist/certs/rds-global-bundle.pem" },
    ]
    secrets = [
      { name = "PGPASSWORD", valueFrom = "${var.master_secret_arn}:password::" },
      { name = "OWNER_ROLE_PASSWORD", valueFrom = "${var.db_owner_secret_arn}:password::" },
      { name = "RUNTIME_ROLE_PASSWORD", valueFrom = "${var.db_runtime_secret_arn}:password::" },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = "/${var.name}/bootstrap"
        awslogs-region        = local.region
        awslogs-stream-prefix = "bootstrap"
      }
    }
  }

  # The idempotency cleanup of IDM-R22, with the runtime role through RDS Proxy (DEP-R37).
  cleanup_container = {
    name                   = "idempotency-cleanup"
    image                  = local.image
    essential              = true
    user                   = "1000"
    readonlyRootFilesystem = true
    entryPoint             = ["node", "dist/cli/idempotency-cleanup.js"]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "DATABASE_URL", value = "postgres://scf_app@${var.proxy_endpoint}:5432/${var.database_name}?sslmode=verify-full" },
    ]
    secrets = [
      { name = "PGPASSWORD", valueFrom = "${var.db_runtime_secret_arn}:password::" },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = "/${var.name}/idempotency-cleanup"
        awslogs-region        = local.region
        awslogs-stream-prefix = "cleanup"
      }
    }
  }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution["api"].arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions    = jsonencode([local.api_container])

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }
}

# Run by the pipeline with `aws ecs run-task` before each deployment of the service; no service
# uses it (DEP-R28).
resource "aws_ecs_task_definition" "migrate" {
  family                   = "${var.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.one_off_cpu
  memory                   = var.one_off_memory
  execution_role_arn       = aws_iam_role.execution["migrate"].arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions    = jsonencode([local.migrate_container])

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }
}

# Run once by an operator before the first migration task; no service or schedule uses it
# (DEP-R40).
resource "aws_ecs_task_definition" "bootstrap" {
  family                   = "${var.name}-bootstrap"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.one_off_cpu
  memory                   = var.one_off_memory
  execution_role_arn       = aws_iam_role.execution["bootstrap"].arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions    = jsonencode([local.bootstrap_container])

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }
}

# Started every hour by the schedule of schedule.tf; no service uses it (DEP-R37).
resource "aws_ecs_task_definition" "cleanup" {
  family                   = "${var.name}-idempotency-cleanup"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.one_off_cpu
  memory                   = var.one_off_memory
  execution_role_arn       = aws_iam_role.execution["cleanup"].arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions    = jsonencode([local.cleanup_container])

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }
}
