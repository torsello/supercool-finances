variable "name" {
  description = "Prefix of every resource name."
  type        = string
}

variable "log_retention_days" {
  description = "Retention of every log group (DEP-R32)."
  type        = number
  default     = 30

  validation {
    condition     = var.log_retention_days == 30
    error_message = "DEP-R32 keeps the logs 30 days."
  }
}

variable "alb_arn_suffix" {
  type = string
}

variable "target_group_arn_suffix" {
  type = string
}

variable "ecs_cluster_name" {
  type = string
}

variable "ecs_service_name" {
  type = string
}

variable "db_instance_identifier" {
  type = string
}

variable "db_instance_arn" {
  description = "The RDS instance whose storage events reach the topic."
  type        = string
}

variable "db_proxy_name" {
  type = string
}

variable "cache_cluster_ids" {
  description = "The nodes of the replication group."
  type        = list(string)
}

variable "waf_web_acl_name" {
  type = string
}

variable "waf_web_acl_arn" {
  type = string
}
