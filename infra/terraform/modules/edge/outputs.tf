output "alb_dns_name" {
  value = aws_lb.this.dns_name
}

output "alb_arn_suffix" {
  value = aws_lb.this.arn_suffix
}

output "target_group_arn" {
  value = aws_lb_target_group.api.arn
}

output "target_group_arn_suffix" {
  value = aws_lb_target_group.api.arn_suffix
}

output "certificate_validation_records" {
  description = "The DNS records that validate the certificate, to create in the domain's zone."
  value       = aws_acm_certificate.this.domain_validation_options
}

output "waf_web_acl_name" {
  value = aws_wafv2_web_acl.this.name
}

output "waf_web_acl_arn" {
  value = aws_wafv2_web_acl.this.arn
}
