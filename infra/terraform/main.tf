# The AWS target architecture of section 1.3 of spec 008 (ADR-0014, ADR-0015), one module per
# component of table 1.3. Never applied from this repository (DEP-R34): `npm run infra:validate`
# only formats, validates and lints it. docs/deployment/aws.md describes each module, the order in
# which an operator applies it and the steps a pipeline runs.

module "network" {
  source = "./modules/network"

  name               = var.name
  availability_zones = var.availability_zones
  vpc_cidr           = var.vpc_cidr
  service_port       = var.service_port
}

module "secrets" {
  source = "./modules/secrets"

  name = var.name
}

module "edge" {
  source = "./modules/edge"

  name                  = var.name
  domain_name           = var.domain_name
  vpc_id                = module.network.vpc_id
  public_subnet_ids     = module.network.public_subnet_ids
  alb_security_group_id = module.network.alb_security_group_id
  service_port          = var.service_port
  idle_timeout_seconds  = var.alb_idle_timeout_seconds
  rate_limit_ip_rps     = var.rate_limit_ip_rps
}

module "database" {
  source = "./modules/database"

  name                          = var.name
  database_name                 = var.database_name
  master_username               = var.db_master_username
  max_allocated_storage_gb      = var.db_max_allocated_storage_gb
  proxy_max_connections_percent = var.db_proxy_max_connections_percent
  isolated_subnet_ids           = module.network.isolated_subnet_ids
  database_security_group_id    = module.network.database_security_group_id
  proxy_security_group_id       = module.network.proxy_security_group_id
  secrets_kms_key_arn           = module.secrets.kms_key_arn
  runtime_secret_arn            = module.secrets.db_runtime_secret_arn
}

module "cache" {
  source = "./modules/cache"

  name                    = var.name
  isolated_subnet_ids     = module.network.isolated_subnet_ids
  cache_security_group_id = module.network.cache_security_group_id
  redis_secret_arn        = module.secrets.redis_secret_arn
  auth_token_version      = var.redis_auth_token_version
}

module "service" {
  source = "./modules/service"

  name                    = var.name
  image_tag               = var.image_tag
  cpu_architecture        = var.cpu_architecture
  task_cpu                = var.task_cpu
  task_memory             = var.task_memory
  one_off_cpu             = 256
  one_off_memory          = 512
  desired_count           = var.desired_count
  min_count               = var.min_tasks
  max_count               = var.max_tasks
  cpu_target_percent      = 60
  service_port            = var.service_port
  metrics_port            = var.metrics_port
  log_level               = var.log_level
  db_pool_max             = var.db_pool_max
  request_timeout_ms      = var.request_timeout_ms
  shutdown_drain_delay_ms = var.shutdown_drain_delay_ms
  shutdown_timeout_ms     = var.shutdown_timeout_ms
  jwt_issuer              = var.jwt_issuer
  jwt_audience            = var.jwt_audience
  trusted_proxy_cidrs     = join(",", module.network.public_subnet_cidrs)
  private_subnet_ids      = module.network.private_subnet_ids
  tasks_security_group_id = module.network.tasks_security_group_id
  target_group_arn        = module.edge.target_group_arn
  jwt_secret_arn          = module.secrets.jwt_secret_arn
  cursor_secret_arn       = module.secrets.cursor_secret_arn
  db_owner_secret_arn     = module.secrets.db_owner_secret_arn
  db_runtime_secret_arn   = module.secrets.db_runtime_secret_arn
  redis_secret_arn        = module.secrets.redis_secret_arn
  master_secret_arn       = module.database.master_secret_arn
  secrets_kms_key_arn     = module.secrets.kms_key_arn
  proxy_endpoint          = module.database.proxy_endpoint
  instance_address        = module.database.instance_address
  database_name           = var.database_name
  master_username         = var.db_master_username

  # The task definitions name their log groups "/<name>/<task>" rather than reading them from the
  # observability module, which keeps the service module readable to checkov; this makes every
  # log group exist before a task can start.
  depends_on = [module.observability]
}

module "observability" {
  source = "./modules/observability"

  name                    = var.name
  alb_arn_suffix          = module.edge.alb_arn_suffix
  target_group_arn_suffix = module.edge.target_group_arn_suffix
  # The names the service module gives, passed from here so that observability, which the
  # service's log groups come from, does not also depend on the service module.
  ecs_cluster_name       = var.name
  ecs_service_name       = "${var.name}-api"
  db_instance_identifier = module.database.instance_identifier
  db_instance_arn        = module.database.instance_arn
  db_proxy_name          = module.database.proxy_name
  cache_cluster_ids      = module.cache.member_cluster_ids
  waf_web_acl_name       = module.edge.waf_web_acl_name
  waf_web_acl_arn        = module.edge.waf_web_acl_arn
}
