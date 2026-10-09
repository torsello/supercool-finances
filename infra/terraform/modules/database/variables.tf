variable "name" {
  description = "Prefix of every resource name."
  type        = string
}

variable "database_name" {
  description = "The database the service uses, owned by scf_owner after the bootstrap."
  type        = string
}

variable "master_username" {
  description = "The RDS master user, used only by the bootstrap task (section 1.7 of spec 008)."
  type        = string
}

variable "max_allocated_storage_gb" {
  description = "The storage autoscaling maximum."
  type        = number
}

variable "proxy_max_connections_percent" {
  description = "The share of max_connections RDS Proxy may use: at most 90 (DEP-R29)."
  type        = number

  validation {
    condition     = var.proxy_max_connections_percent >= 1 && var.proxy_max_connections_percent <= 90
    error_message = "RDS Proxy leaves at least 10% of the instance's connections to direct sessions (DEP-R29)."
  }
}

variable "max_connections" {
  description = "max_connections of the parameter group, a static parameter (SEC-R36)."
  type        = number
}

variable "isolated_subnet_ids" {
  type = list(string)
}

variable "database_security_group_id" {
  type = string
}

variable "proxy_security_group_id" {
  type = string
}

variable "secrets_kms_key_arn" {
  description = "The secrets module's key, which also encrypts RDS's master secret (DEP-R31)."
  type        = string
}

variable "runtime_secret_arn" {
  description = "The runtime role's secret, the only one RDS Proxy reads."
  type        = string
}
