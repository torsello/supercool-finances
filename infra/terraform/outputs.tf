output "alb_dns_name" {
  description = "Point the domain's record at it once the certificate is issued."
  value       = module.edge.alb_dns_name
}

output "certificate_validation_records" {
  description = "The DNS records that validate the ACM certificate."
  value       = module.edge.certificate_validation_records
}

output "ecr_repository_url" {
  description = "Where the pipeline pushes the service image."
  value       = module.service.ecr_repository_url
}

output "cluster_name" {
  value = module.service.cluster_name
}

output "service_name" {
  value = module.service.service_name
}

output "task_definition_arns" {
  description = "api, migrate, bootstrap and cleanup."
  value       = module.service.task_definition_arns
}

output "private_subnet_ids" {
  description = "The subnets of `aws ecs run-task` for the one-off tasks."
  value       = module.network.private_subnet_ids
}

output "one_off_db_security_group_id" {
  description = "The security group of `aws ecs run-task` for the migration and bootstrap tasks."
  value       = module.network.one_off_db_security_group_id
}

output "tasks_security_group_id" {
  description = "The security group of the service and cleanup tasks."
  value       = module.network.tasks_security_group_id
}

output "secret_arns" {
  description = "The secrets whose values an operator sets (docs/deployment/aws.md)."
  value = {
    jwt_secret    = module.secrets.jwt_secret_arn
    cursor_secret = module.secrets.cursor_secret_arn
    db_owner      = module.secrets.db_owner_secret_arn
    db_runtime    = module.secrets.db_runtime_secret_arn
    redis         = module.secrets.redis_secret_arn
  }
}

output "redis_primary_endpoint" {
  description = "The host of the url key of the Redis secret."
  value       = module.cache.primary_endpoint
}

output "alarm_topic_arn" {
  value = module.observability.alarm_topic_arn
}
