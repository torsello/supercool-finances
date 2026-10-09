variable "name" {
  description = "Prefix of every resource name."
  type        = string
}

variable "node_count" {
  description = "Nodes of the replication group: a primary and at least one replica in another zone."
  type        = number
  default     = 2

  validation {
    condition     = var.node_count >= 2
    error_message = "DEP-R30 needs at least 2 nodes in two availability zones."
  }
}

variable "isolated_subnet_ids" {
  type = list(string)
}

variable "cache_security_group_id" {
  type = string
}

variable "redis_secret_arn" {
  description = "The Redis secret: JSON with auth_token and url."
  type        = string
}

variable "auth_token_version" {
  description = "Raise it after changing auth_token in the secret, so the next apply sends the new token."
  type        = number
}
