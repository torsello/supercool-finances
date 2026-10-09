output "primary_endpoint" {
  description = "The host of the url key of the Redis secret."
  value       = aws_elasticache_replication_group.this.primary_endpoint_address
}

output "replication_group_id" {
  value = aws_elasticache_replication_group.this.id
}

output "member_cluster_ids" {
  description = "The node ids ElastiCache gives a replication group: <id>-001, <id>-002, ..."
  value       = [for index in range(var.node_count) : format("%s-%03d", var.name, index + 1)]
}
