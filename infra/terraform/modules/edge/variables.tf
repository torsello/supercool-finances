variable "name" {
  description = "Prefix of every resource name."
  type        = string
}

variable "domain_name" {
  description = "The domain of the ACM certificate the HTTPS listener serves."
  type        = string
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "alb_security_group_id" {
  type = string
}

variable "service_port" {
  description = "The service's PORT, which the target group reaches."
  type        = number
}

variable "idle_timeout_seconds" {
  description = "The ALB idle timeout, above REQUEST_TIMEOUT_MS (SEC-R34)."
  type        = number
}

variable "rate_limit_ip_rps" {
  description = "RATE_LIMIT_IP_RPS: the WAF rule allows 60 times it per IP per minute (SEC-R45)."
  type        = number
}
