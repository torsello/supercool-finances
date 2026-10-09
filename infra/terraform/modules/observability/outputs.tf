output "alarm_topic_arn" {
  description = "The one SNS topic every alarm notifies; subscribe the on-call to it."
  value       = aws_sns_topic.alarms.arn
}
