variable "name" {
  description = "Prefix of every resource name."
  type        = string
}

variable "availability_zones" {
  description = "The two availability zones, named explicitly so the set never grows on its own."
  type        = list(string)

  validation {
    condition     = length(var.availability_zones) == 2
    error_message = "The network spans exactly two availability zones (section 1.3 of spec 008)."
  }
}

variable "vpc_cidr" {
  description = "The VPC's IPv4 block, split into six /20 subnets when it is a /16."
  type        = string
}

variable "service_port" {
  description = "The service's PORT, which the ALB reaches on the tasks."
  type        = number
}
