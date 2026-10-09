output "kms_key_arn" {
  value = aws_kms_key.secrets.arn
}

output "jwt_secret_arn" {
  value = aws_secretsmanager_secret.jwt_secret.arn
}

output "cursor_secret_arn" {
  value = aws_secretsmanager_secret.cursor_secret.arn
}

output "db_owner_secret_arn" {
  value = aws_secretsmanager_secret.db_owner.arn
}

output "db_runtime_secret_arn" {
  value = aws_secretsmanager_secret.db_runtime.arn
}

output "redis_secret_arn" {
  value = aws_secretsmanager_secret.redis.arn
}
