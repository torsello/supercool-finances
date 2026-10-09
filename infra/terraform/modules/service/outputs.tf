output "ecr_repository_url" {
  value = aws_ecr_repository.this.repository_url
}

output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "service_name" {
  value = aws_ecs_service.api.name
}

output "task_definition_arns" {
  description = "api, migrate, bootstrap and cleanup, for `aws ecs run-task` and the pipeline."
  value = {
    api       = aws_ecs_task_definition.api.arn
    migrate   = aws_ecs_task_definition.migrate.arn
    bootstrap = aws_ecs_task_definition.bootstrap.arn
    cleanup   = aws_ecs_task_definition.cleanup.arn
  }
}
