# One security group per layer (DEP-R25, DEP-AC16). From the internet, only the ALB on 443 and
# 80; every other group admits traffic only from the group in front of it. The tasks' METRICS_PORT
# has no rule at all (SEC-R43). No group allows egress to 0.0.0.0/0 except to the AWS services'
# endpoints, which stay inside the VPC.

resource "aws_security_group" "alb" {
  #checkov:skip=CKV2_AWS_5:Attached in another module through this module's outputs, which checkov does not connect (ADR-0015).
  name        = "${var.name}-alb"
  description = "ALB: HTTPS and HTTP from the internet, HTTP to the tasks"
  vpc_id      = aws_vpc.this.id
}

resource "aws_security_group" "tasks" {
  #checkov:skip=CKV2_AWS_5:Attached in another module through this module's outputs, which checkov does not connect (ADR-0015).
  name        = "${var.name}-tasks"
  description = "Service and cleanup tasks: PORT from the ALB only"
  vpc_id      = aws_vpc.this.id
}

resource "aws_security_group" "one_off_db" {
  #checkov:skip=CKV2_AWS_5:Attached in another module through this module's outputs, which checkov does not connect (ADR-0015).
  name        = "${var.name}-one-off-db"
  description = "Migration and bootstrap tasks: no inbound, PostgreSQL to the RDS instance"
  vpc_id      = aws_vpc.this.id
}

resource "aws_security_group" "endpoints" {
  name        = "${var.name}-endpoints"
  description = "VPC interface endpoints: HTTPS from the tasks"
  vpc_id      = aws_vpc.this.id
}

resource "aws_security_group" "proxy" {
  #checkov:skip=CKV2_AWS_5:Attached in another module through this module's outputs, which checkov does not connect (ADR-0015).
  name        = "${var.name}-rds-proxy"
  description = "RDS Proxy: PostgreSQL from the service and cleanup tasks"
  vpc_id      = aws_vpc.this.id
}

resource "aws_security_group" "database" {
  #checkov:skip=CKV2_AWS_5:Attached in another module through this module's outputs, which checkov does not connect (ADR-0015).
  name        = "${var.name}-rds"
  description = "RDS: PostgreSQL from RDS Proxy and the migration and bootstrap tasks"
  vpc_id      = aws_vpc.this.id
}

resource "aws_security_group" "cache" {
  #checkov:skip=CKV2_AWS_5:Attached in another module through this module's outputs, which checkov does not connect (ADR-0015).
  name        = "${var.name}-cache"
  description = "ElastiCache: Redis from the service tasks"
  vpc_id      = aws_vpc.this.id
}

# ALB: the only rules open to the internet.
resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from the internet"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  #checkov:skip=CKV_AWS_260:DEP-R25 and DEP-R26 open port 80 on the ALB only, to answer every request with a redirect to HTTPS (ADR-0014).
  security_group_id = aws_security_group.alb.id
  description       = "HTTP from the internet, answered with a redirect to HTTPS"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "alb_to_tasks" {
  security_group_id            = aws_security_group.alb.id
  description                  = "HTTP to the tasks on PORT"
  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = var.service_port
  to_port                      = var.service_port
}

# Tasks: PORT from the ALB only; out to the endpoints, RDS Proxy and ElastiCache.
resource "aws_vpc_security_group_ingress_rule" "tasks_from_alb" {
  security_group_id            = aws_security_group.tasks.id
  description                  = "PORT from the ALB"
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = var.service_port
  to_port                      = var.service_port
}

resource "aws_vpc_security_group_egress_rule" "tasks_to_endpoints" {
  security_group_id            = aws_security_group.tasks.id
  description                  = "HTTPS to the interface endpoints"
  referenced_security_group_id = aws_security_group.endpoints.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

resource "aws_vpc_security_group_egress_rule" "tasks_to_s3" {
  security_group_id = aws_security_group.tasks.id
  description       = "HTTPS to S3 through the gateway endpoint, for image layers"
  prefix_list_id    = aws_vpc_endpoint.s3.prefix_list_id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "tasks_to_proxy" {
  security_group_id            = aws_security_group.tasks.id
  description                  = "PostgreSQL to RDS Proxy"
  referenced_security_group_id = aws_security_group.proxy.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_egress_rule" "tasks_to_cache" {
  security_group_id            = aws_security_group.tasks.id
  description                  = "Redis to ElastiCache"
  referenced_security_group_id = aws_security_group.cache.id
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
}

# Migration and bootstrap tasks: no inbound rule; out to the endpoints and the RDS instance.
resource "aws_vpc_security_group_egress_rule" "one_off_to_endpoints" {
  security_group_id            = aws_security_group.one_off_db.id
  description                  = "HTTPS to the interface endpoints"
  referenced_security_group_id = aws_security_group.endpoints.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

resource "aws_vpc_security_group_egress_rule" "one_off_to_s3" {
  security_group_id = aws_security_group.one_off_db.id
  description       = "HTTPS to S3 through the gateway endpoint, for image layers"
  prefix_list_id    = aws_vpc_endpoint.s3.prefix_list_id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "one_off_to_database" {
  security_group_id            = aws_security_group.one_off_db.id
  description                  = "PostgreSQL to the RDS instance, not through the proxy (ADR-0019)"
  referenced_security_group_id = aws_security_group.database.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

# Interface endpoints: HTTPS from the tasks of both groups.
resource "aws_vpc_security_group_ingress_rule" "endpoints_from_tasks" {
  security_group_id            = aws_security_group.endpoints.id
  description                  = "HTTPS from the service and cleanup tasks"
  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_from_one_off" {
  security_group_id            = aws_security_group.endpoints.id
  description                  = "HTTPS from the migration and bootstrap tasks"
  referenced_security_group_id = aws_security_group.one_off_db.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

# RDS Proxy: 5432 from the tasks only; out to the RDS instance.
resource "aws_vpc_security_group_ingress_rule" "proxy_from_tasks" {
  security_group_id            = aws_security_group.proxy.id
  description                  = "PostgreSQL from the service and cleanup tasks"
  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_egress_rule" "proxy_to_database" {
  security_group_id            = aws_security_group.proxy.id
  description                  = "PostgreSQL to the RDS instance"
  referenced_security_group_id = aws_security_group.database.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

# RDS: 5432 from RDS Proxy and from the migration and bootstrap tasks only.
resource "aws_vpc_security_group_ingress_rule" "database_from_proxy" {
  security_group_id            = aws_security_group.database.id
  description                  = "PostgreSQL from RDS Proxy"
  referenced_security_group_id = aws_security_group.proxy.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_ingress_rule" "database_from_one_off" {
  security_group_id            = aws_security_group.database.id
  description                  = "PostgreSQL from the migration and bootstrap tasks"
  referenced_security_group_id = aws_security_group.one_off_db.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

# ElastiCache: 6379 from the tasks only.
resource "aws_vpc_security_group_ingress_rule" "cache_from_tasks" {
  security_group_id            = aws_security_group.cache.id
  description                  = "Redis from the service tasks"
  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
}
