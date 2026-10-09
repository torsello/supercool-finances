variable "name" {
  description = "Prefix of every resource name."
  type        = string
}

variable "image_tag" {
  description = "The tag of the service image in this module's ECR repository, pushed by the pipeline."
  type        = string
}

variable "cpu_architecture" {
  description = "X86_64 or ARM64, the architecture the pipeline builds the image for."
  type        = string
}

variable "task_cpu" {
  description = "CPU units of a service task: 512 is 0.5 vCPU (section 1.7 of spec 008)."
  type        = number
}

variable "task_memory" {
  description = "Memory of a service task in MiB (section 1.7 of spec 008)."
  type        = number
}

variable "one_off_cpu" {
  description = "CPU units of the migration, bootstrap and cleanup tasks."
  type        = number
}

variable "one_off_memory" {
  description = "Memory of the migration, bootstrap and cleanup tasks in MiB."
  type        = number
}

variable "desired_count" {
  type = number
}

variable "min_count" {
  type = number
}

variable "max_count" {
  type = number
}

variable "cpu_target_percent" {
  description = "The average CPU autoscaling keeps the service at."
  type        = number
}

variable "service_port" {
  description = "PORT."
  type        = number
}

variable "metrics_port" {
  description = "METRICS_PORT, which no security group admits (SEC-R43)."
  type        = number
}

variable "log_level" {
  type = string
}

variable "db_pool_max" {
  type = number
}

variable "request_timeout_ms" {
  type = number
}

variable "shutdown_drain_delay_ms" {
  type = number
}

variable "shutdown_timeout_ms" {
  type = number
}

variable "jwt_issuer" {
  type = string
}

variable "jwt_audience" {
  type = string
}

variable "trusted_proxy_cidrs" {
  description = "TRUSTED_PROXY_CIDRS: the subnets of the ALB's nodes, comma-separated."
  type        = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "tasks_security_group_id" {
  type = string
}

variable "target_group_arn" {
  type = string
}

variable "jwt_secret_arn" {
  description = "JWT_SECRET's secret."
  type        = string
}

variable "cursor_secret_arn" {
  description = "CURSOR_SECRET's secret."
  type        = string
}

variable "db_owner_secret_arn" {
  description = "The owner role's secret, read by the migration and bootstrap tasks only."
  type        = string
}

variable "db_runtime_secret_arn" {
  description = "The runtime role's secret."
  type        = string
}

variable "redis_secret_arn" {
  description = "The Redis secret, whose url key is REDIS_URL."
  type        = string
}

variable "master_secret_arn" {
  description = "RDS's managed master secret, for the bootstrap task only."
  type        = string
}

variable "secrets_kms_key_arn" {
  type = string
}

variable "proxy_endpoint" {
  type = string
}

variable "instance_address" {
  type = string
}

variable "database_name" {
  type = string
}

variable "master_username" {
  type = string
}
