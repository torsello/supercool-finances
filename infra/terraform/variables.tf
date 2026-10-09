# The settings of section 1.7 of spec 008. The service's own variables keep the names and defaults
# of section 1.2 of spec 007; the checks below repeat the budgets the deployment must keep.

variable "aws_region" {
  description = "The AWS region, for example eu-west-1."
  type        = string
}

variable "name" {
  description = "Prefix of every resource name."
  type        = string
  default     = "scf"
}

variable "domain_name" {
  description = "The domain of the ACM certificate the ALB serves (section 1.7 of spec 008)."
  type        = string
}

variable "image_tag" {
  description = "The service image's tag in the ECR repository, pushed by the pipeline."
  type        = string
}

variable "cpu_architecture" {
  description = "X86_64 or ARM64: the platform the pipeline builds the image for."
  type        = string
  default     = "X86_64"

  validation {
    condition     = contains(["X86_64", "ARM64"], var.cpu_architecture)
    error_message = "cpu_architecture is X86_64 or ARM64."
  }
}

variable "availability_zones" {
  description = "The two availability zones of the region, for example eu-west-1a and eu-west-1b."
  type        = list(string)
}

variable "vpc_cidr" {
  description = "The VPC's IPv4 block."
  type        = string
  default     = "10.20.0.0/16"
}

variable "service_port" {
  description = "PORT (section 1.2 of spec 007)."
  type        = number
  default     = 3000
}

variable "metrics_port" {
  description = "METRICS_PORT, never admitted by any security group (SEC-R43)."
  type        = number
  default     = 9464
}

variable "task_cpu" {
  description = "0.5 vCPU per service task."
  type        = number
  default     = 512
}

variable "task_memory" {
  description = "1 GB per service task."
  type        = number
  default     = 1024
}

variable "desired_count" {
  description = "Service tasks at deployment: at least 2, across two availability zones (DEP-R27)."
  type        = number
  default     = 2

  validation {
    condition     = var.desired_count >= 2
    error_message = "DEP-R27 runs at least 2 tasks."
  }
}

variable "min_tasks" {
  description = "Autoscaling minimum (section 1.7 of spec 008)."
  type        = number
  default     = 2

  validation {
    condition     = var.min_tasks >= 2
    error_message = "DEP-R27 runs at least 2 tasks."
  }
}

variable "max_tasks" {
  description = "Autoscaling maximum; with DB_POOL_MAX it bounds the connections to RDS Proxy (SEC-R36)."
  type        = number
  default     = 6
}

variable "db_pool_max" {
  description = "DB_POOL_MAX: 6 tasks x (10 + 1) = 66 connections to RDS Proxy (SEC-R36)."
  type        = number
  default     = 10
}

variable "request_timeout_ms" {
  description = "REQUEST_TIMEOUT_MS, below the ALB idle timeout (SEC-R34, SEC-R47)."
  type        = number
  default     = 25000

  validation {
    condition     = var.request_timeout_ms < var.alb_idle_timeout_seconds * 1000
    error_message = "REQUEST_TIMEOUT_MS must stay below the ALB idle timeout (SEC-R47)."
  }
}

variable "alb_idle_timeout_seconds" {
  description = "The ALB idle timeout: above REQUEST_TIMEOUT_MS, below the service's keep-alive of 65 s."
  type        = number
  default     = 60

  validation {
    condition     = var.alb_idle_timeout_seconds < 65
    error_message = "The service's keep-alive timeout of 65 s must stay above the ALB's (SEC-R34)."
  }
}

variable "shutdown_drain_delay_ms" {
  description = "SHUTDOWN_DRAIN_DELAY_MS (section 1.8 of spec 007)."
  type        = number
  default     = 2000
}

variable "shutdown_timeout_ms" {
  description = "SHUTDOWN_TIMEOUT_MS (section 1.8 of spec 007)."
  type        = number
  default     = 30000

  validation {
    condition     = var.shutdown_drain_delay_ms + var.shutdown_timeout_ms < 40000
    error_message = "The task definition's stopTimeout of 40 s must exceed SHUTDOWN_DRAIN_DELAY_MS + SHUTDOWN_TIMEOUT_MS (DEP-R27)."
  }
}

variable "log_level" {
  description = "LOG_LEVEL."
  type        = string
  default     = "info"
}

variable "jwt_issuer" {
  description = "JWT_ISSUER (spec 006)."
  type        = string
}

variable "jwt_audience" {
  description = "JWT_AUDIENCE (spec 006)."
  type        = string
}

variable "rate_limit_ip_rps" {
  description = "RATE_LIMIT_IP_RPS: the WAF rule allows 60 times it per IP per minute (SEC-R45)."
  type        = number
  default     = 500
}

variable "database_name" {
  description = "The service's database."
  type        = string
  default     = "supercool"
}

variable "db_master_username" {
  description = "The RDS master user, used only by the bootstrap task."
  type        = string
  default     = "scf_master"
}

variable "db_max_allocated_storage_gb" {
  description = "The storage autoscaling maximum (section 1.7 of spec 008)."
  type        = number
  default     = 100
}

variable "db_proxy_max_connections_percent" {
  description = "The share of max_connections RDS Proxy may use: at most 90 (DEP-R29)."
  type        = number
  default     = 90
}

variable "redis_auth_token_version" {
  description = "Raise it after changing auth_token in the Redis secret, so the next apply sends it."
  type        = number
  default     = 1
}
