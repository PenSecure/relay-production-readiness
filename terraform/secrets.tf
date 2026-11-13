# Secret *containers* only. Terraform never sees the values:
#   - database-url: written by the data team (they own the DB credentials),
#     ideally with rotation. Format postgres://...?sslmode=verify-full
#   - signing-secret: generated once by the service owner.
# Previously the prod DB password was a variable default committed to git
# and stored in plaintext in Terraform state.
# External Secrets syncs both into the cluster (k8s/prod/externalsecret.yaml).

resource "aws_secretsmanager_secret" "database_url" {
  name       = "${var.name}/database-url"
  kms_key_id = aws_kms_key.this.arn
}

resource "aws_secretsmanager_secret" "signing_secret" {
  name       = "${var.name}/signing-secret"
  kms_key_id = aws_kms_key.this.arn
}
