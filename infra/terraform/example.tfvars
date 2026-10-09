# An example of the values whoever applies this configuration supplies (docs/deployment/aws.md).
# No secret goes here: every secret is set in Secrets Manager (DEP-R31).
aws_region         = "eu-west-1"
availability_zones = ["eu-west-1a", "eu-west-1b"]
domain_name        = "api.example.com"
image_tag          = "2026-10-09-0123abc"
jwt_issuer         = "https://auth.example.com/"
jwt_audience       = "supercool-finances-api"

# The defaults of section 1.7 of spec 008, written out:
# desired_count            = 2
# min_tasks                = 2
# max_tasks                = 6
# db_pool_max              = 10
# request_timeout_ms       = 25000
# alb_idle_timeout_seconds = 60
# rate_limit_ip_rps        = 500
