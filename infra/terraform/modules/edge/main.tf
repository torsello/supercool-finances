# Edge (table 1.3 of spec 008, DEP-R26): the ALB with an HTTPS listener and an HTTP-to-HTTPS
# redirect, its target group, and the AWS WAF web ACL with the per-IP rate-based rule of SEC-R45
# and the managed rule groups of section 1.7. Traffic from the ALB to the tasks is plain HTTP
# inside the VPC.

# Validated by DNS records in the domain's zone, which are out of scope (section 6 of spec 008):
# the operator creates the records of the output certificate_validation_records before this module
# is applied as a whole. AWS refuses an HTTPS listener whose certificate is not issued, so the
# listener takes the certificate from aws_acm_certificate_validation, which waits for the issue
# (docs/deployment/aws.md).
resource "aws_acm_certificate" "this" {
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_acm_certificate_validation" "this" {
  certificate_arn = aws_acm_certificate.this.arn
}

resource "aws_lb" "this" {
  #checkov:skip=CKV_AWS_91:Access logs need an S3 bucket that section 1.7 of spec 008 does not define; WAF logs and the ALB metrics of section 1.8 cover the edge (ADR-0014).
  #checkov:skip=CKV2_AWS_76:The web ACL holds the managed rule groups section 1.7 of spec 008 names, the known-bad-inputs group (Log4j) among them, and not AnonymousIpList (ADR-0013).
  name                       = var.name
  load_balancer_type         = "application"
  internal                   = false
  subnets                    = var.public_subnet_ids
  security_groups            = [var.alb_security_group_id]
  drop_invalid_header_fields = true
  # Above the service's REQUEST_TIMEOUT_MS and below its keep-alive of 65 s (SEC-R34).
  idle_timeout               = var.idle_timeout_seconds
  enable_deletion_protection = true
}

resource "aws_lb_target_group" "api" {
  name        = "${var.name}-api"
  port        = var.service_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id
  # Above the 2 s drain delay, so the ALB stops sending before the task stops listening, and
  # within the 40 s stop timeout (section 1.7, SEC-R25).
  deregistration_delay = 35

  # Liveness, not readiness: ECS replaces every task the ALB reports unhealthy, so checking
  # readiness would make a database outage replace every task. While the database is down,
  # requests answer 503 on their own (DEP-R27, section 1.6 of spec 008).
  health_check {
    path                = "/health/live"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.this.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      protocol    = "HTTPS"
      port        = "443"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_wafv2_web_acl" "this" {
  #checkov:skip=CKV2_AWS_31:Its logging configuration lives in the observability module with the log group, which checkov does not connect across modules (ADR-0015).
  name  = var.name
  scope = "REGIONAL"

  default_action {
    allow {}
  }

  # SEC-R45: per client IP over a 1-minute window, which allows no burst, so the limit is
  # 60 x RATE_LIMIT_IP_RPS (section 1.6 of spec 007).
  rule {
    name     = "per-ip-rate-limit"
    priority = 0

    action {
      block {}
    }

    statement {
      rate_based_statement {
        aggregate_key_type    = "IP"
        evaluation_window_sec = 60
        limit                 = 60 * var.rate_limit_ip_rps
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-per-ip-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-common-rule-set"
    priority = 1

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesCommonRuleSet"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-aws-common-rule-set"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-known-bad-inputs"
    priority = 2

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-aws-known-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = var.name
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "alb" {
  resource_arn = aws_lb.this.arn
  web_acl_arn  = aws_wafv2_web_acl.this.arn
}
