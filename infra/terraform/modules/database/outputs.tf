output "instance_identifier" {
  value = aws_db_instance.this.identifier
}

output "instance_arn" {
  value = aws_db_instance.this.arn
}

output "instance_address" {
  description = "The instance's endpoint, used only by the migration and bootstrap tasks."
  value       = aws_db_instance.this.address
}

output "proxy_endpoint" {
  description = "RDS Proxy's endpoint, the only database host of the service and the cleanup task."
  value       = aws_db_proxy.this.endpoint
}

output "proxy_name" {
  value = aws_db_proxy.this.name
}

output "master_secret_arn" {
  description = "RDS's managed master secret, read only by the bootstrap task."
  value       = one(aws_db_instance.this.master_user_secret[*].secret_arn)
}

output "max_allocated_storage_gb" {
  value = aws_db_instance.this.max_allocated_storage
}
