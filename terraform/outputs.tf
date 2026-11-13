output "alb_dns_name" {
  value = aws_lb.this.dns_name
}

output "cluster_endpoint" {
  value = aws_eks_cluster.this.endpoint
}

output "archive_bucket" {
  value = aws_s3_bucket.archive.bucket
}

output "app_role_arn" {
  description = "Annotate the relay ServiceAccount with this (k8s/prod)"
  value       = aws_iam_role.app.arn
}

output "secret_arns" {
  description = "Grant the External Secrets role read access to these"
  value = {
    database_url   = aws_secretsmanager_secret.database_url.arn
    signing_secret = aws_secretsmanager_secret.signing_secret.arn
  }
}
