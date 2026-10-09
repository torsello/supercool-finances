# The alarms of section 1.8 of spec 008, exactly those, each on a metric AWS publishes and each
# notifying the one SNS topic of this module (DEP-R32, DEP-AC23).

# ALB 5xx: above 1% of requests over 5 minutes, counting the load balancer's own 5xx and the
# targets'.
resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${var.name}-alb-5xx"
  alarm_description   = "ALB 5xx above 1% of requests over 5 minutes (section 1.8 of spec 008)."
  comparison_operator = "GreaterThanThreshold"
  threshold           = 1
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]

  metric_query {
    id          = "percent"
    expression  = "100 * (FILL(elb5xx, 0) + FILL(target5xx, 0)) / requests"
    label       = "5xx percent of requests"
    return_data = true
  }

  metric_query {
    id = "elb5xx"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_ELB_5XX_Count"
      dimensions  = { LoadBalancer = var.alb_arn_suffix }
      period      = 300
      stat        = "Sum"
    }
  }

  metric_query {
    id = "target5xx"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_5XX_Count"
      dimensions  = { LoadBalancer = var.alb_arn_suffix }
      period      = 300
      stat        = "Sum"
    }
  }

  metric_query {
    id = "requests"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "RequestCount"
      dimensions  = { LoadBalancer = var.alb_arn_suffix }
      period      = 300
      stat        = "Sum"
    }
  }
}

# ALB target response time: p99 above 300 ms over 5 minutes (SYS-R20).
resource "aws_cloudwatch_metric_alarm" "alb_target_response_time" {
  alarm_name          = "${var.name}-alb-target-response-time-p99"
  alarm_description   = "ALB target response time p99 above 300 ms over 5 minutes (SYS-R20)."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  dimensions          = { LoadBalancer = var.alb_arn_suffix, TargetGroup = var.target_group_arn_suffix }
  extended_statistic  = "p99"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0.3
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

# ALB healthy targets: fewer than 2.
resource "aws_cloudwatch_metric_alarm" "alb_healthy_targets" {
  alarm_name          = "${var.name}-alb-healthy-targets"
  alarm_description   = "Fewer than 2 healthy targets behind the ALB (DEP-R27)."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HealthyHostCount"
  dimensions          = { LoadBalancer = var.alb_arn_suffix, TargetGroup = var.target_group_arn_suffix }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 1
  comparison_operator = "LessThanThreshold"
  threshold           = 2
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

# ECS CPU and ECS memory: above 80%.
resource "aws_cloudwatch_metric_alarm" "ecs_cpu" {
  alarm_name          = "${var.name}-ecs-cpu"
  alarm_description   = "ECS service CPU above 80%."
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  dimensions          = { ClusterName = var.ecs_cluster_name, ServiceName = var.ecs_service_name }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 80
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "ecs_memory" {
  alarm_name          = "${var.name}-ecs-memory"
  alarm_description   = "ECS service memory above 80%."
  namespace           = "AWS/ECS"
  metric_name         = "MemoryUtilization"
  dimensions          = { ClusterName = var.ecs_cluster_name, ServiceName = var.ecs_service_name }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 80
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

# RDS CPU: above 80%.
resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${var.name}-rds-cpu"
  alarm_description   = "RDS CPU above 80%."
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = { DBInstanceIdentifier = var.db_instance_identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 80
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

# RDS connections: above 80% of RDS Proxy's connection limit, as the proxy reports both.
resource "aws_cloudwatch_metric_alarm" "rds_connections" {
  alarm_name          = "${var.name}-rds-connections"
  alarm_description   = "RDS Proxy's database connections above 80% of its connection limit."
  comparison_operator = "GreaterThanThreshold"
  threshold           = 80
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]

  metric_query {
    id          = "percent"
    expression  = "100 * connections / allowed"
    label       = "Percent of the proxy's connection limit"
    return_data = true
  }

  metric_query {
    id = "connections"
    metric {
      namespace   = "AWS/RDS"
      metric_name = "DatabaseConnections"
      dimensions  = { ProxyName = var.db_proxy_name }
      period      = 300
      stat        = "Sum"
    }
  }

  metric_query {
    id = "allowed"
    metric {
      namespace   = "AWS/RDS"
      metric_name = "MaxDatabaseConnectionsAllowed"
      dimensions  = { ProxyName = var.db_proxy_name }
      period      = 300
      stat        = "Sum"
    }
  }
}

# RDS Proxy pinned connections: Maximum above 0 over 5 minutes (ADR-0019).
resource "aws_cloudwatch_metric_alarm" "rds_proxy_pinned" {
  alarm_name          = "${var.name}-rds-proxy-pinned"
  alarm_description   = "RDS Proxy connections pinned by session state (ADR-0019, SEC-R30)."
  namespace           = "AWS/RDS"
  metric_name         = "DatabaseConnectionsCurrentlySessionPinned"
  dimensions          = { ProxyName = var.db_proxy_name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

# ElastiCache memory: above 80% on any node of the replication group.
resource "aws_cloudwatch_metric_alarm" "cache_memory" {
  alarm_name          = "${var.name}-cache-memory"
  alarm_description   = "ElastiCache memory above 80% on any node."
  comparison_operator = "GreaterThanThreshold"
  threshold           = 80
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]

  metric_query {
    id          = "highest"
    expression  = "MAX(METRICS())"
    label       = "Highest memory use of any node"
    return_data = true
  }

  dynamic "metric_query" {
    for_each = { for index, id in var.cache_cluster_ids : "node${index}" => id }

    content {
      id = metric_query.key
      metric {
        namespace   = "AWS/ElastiCache"
        metric_name = "DatabaseMemoryUsagePercentage"
        dimensions  = { CacheClusterId = metric_query.value }
        period      = 300
        stat        = "Maximum"
      }
    }
  }
}

# WAF blocked requests: above 1000 in 5 minutes.
resource "aws_cloudwatch_metric_alarm" "waf_blocked" {
  alarm_name          = "${var.name}-waf-blocked-requests"
  alarm_description   = "AWS WAF blocked more than 1000 requests in 5 minutes."
  namespace           = "AWS/WAFV2"
  metric_name         = "BlockedRequests"
  dimensions          = { WebACL = var.waf_web_acl_name, Rule = "ALL", Region = local.region }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 1000
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

# RDS storage running out under storage autoscaling (section 1.8): the RDS events that say the
# space is really running out, not every autoscaling step. RDS-EVENT-0225: allocated storage at 80%
# of the autoscaling maximum; RDS-EVENT-0224: a pending autoscaling step would reach the maximum;
# RDS-EVENT-0223: autoscaling cannot scale; RDS-EVENT-0007: storage exhausted. An RDS event
# subscription filters only by category, which would bring RDS-EVENT-0089 before every
# autoscaling step and leave out 0223, 0224 and 0225, so an EventBridge rule picks these four.
resource "aws_cloudwatch_event_rule" "rds_storage" {
  name        = "${var.name}-rds-storage"
  description = "RDS storage running out under storage autoscaling (section 1.8 of spec 008)."
  event_pattern = jsonencode({
    source        = ["aws.rds"]
    "detail-type" = ["RDS DB Instance Event"]
    resources     = [var.db_instance_arn]
    detail = {
      EventID = ["RDS-EVENT-0007", "RDS-EVENT-0223", "RDS-EVENT-0224", "RDS-EVENT-0225"]
    }
  })
}

resource "aws_cloudwatch_event_target" "rds_storage" {
  rule = aws_cloudwatch_event_rule.rds_storage.name
  arn  = aws_sns_topic.alarms.arn
}
