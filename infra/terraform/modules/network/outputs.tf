output "vpc_id" {
  value = aws_vpc.this.id
}

output "public_subnet_ids" {
  value = aws_subnet.public[*].id
}

output "public_subnet_cidrs" {
  description = "Where the ALB's nodes live: the only proxies whose X-Forwarded-For the service trusts."
  value       = aws_subnet.public[*].cidr_block
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}

output "isolated_subnet_ids" {
  value = aws_subnet.isolated[*].id
}

# The security group of each layer (DEP-R25), one output each.
output "alb_security_group_id" {
  value = aws_security_group.alb.id
}

output "tasks_security_group_id" {
  value = aws_security_group.tasks.id
}

output "one_off_db_security_group_id" {
  description = "For `aws ecs run-task` of the migration and bootstrap tasks."
  value       = aws_security_group.one_off_db.id
}

output "proxy_security_group_id" {
  value = aws_security_group.proxy.id
}

output "database_security_group_id" {
  value = aws_security_group.database.id
}

output "cache_security_group_id" {
  value = aws_security_group.cache.id
}
