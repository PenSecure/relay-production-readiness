# GitHub Actions -> AWS via OIDC. No long-lived access keys (the old
# pipeline used AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY secrets).

variable "github_repository" {
  description = "owner/repo allowed to assume the CI role"
  type        = string
  default     = "PenSecure/relay-production-readiness"
}

data "aws_iam_openid_connect_provider" "github" {
  # Account-wide, usually created once by the platform team.
  url = "https://token.actions.githubusercontent.com"
}

data "aws_iam_policy_document" "ci_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    # Release tags may push images. Only the protected "production"
    # environment (reviewer approval in GitHub) may deploy. Branch builds
    # and pull requests cannot assume this role at all. Protect v* tags
    # with a tag ruleset so only maintainers can create them.
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "repo:${var.github_repository}:ref:refs/tags/v*",
        "repo:${var.github_repository}:environment:production",
      ]
    }
  }
}

resource "aws_iam_role" "ci" {
  name                 = "${var.name}-ci"
  assume_role_policy   = data.aws_iam_policy_document.ci_assume.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "ci" {
  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid = "EcrPush"
    actions = [
      "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage",
    ]
    resources = [aws_ecr_repository.relay.arn]
  }
  statement {
    sid       = "EcrKms"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [aws_kms_key.this.arn]
  }
  statement {
    sid       = "DescribeCluster"
    actions   = ["eks:DescribeCluster"]
    resources = [aws_eks_cluster.this.arn]
  }
}

resource "aws_iam_role_policy" "ci" {
  role   = aws_iam_role.ci.id
  policy = data.aws_iam_policy_document.ci.json
}

# Kubernetes permissions: edit, in the relay namespace only. Not cluster-admin.
resource "aws_eks_access_entry" "ci" {
  cluster_name  = aws_eks_cluster.this.name
  principal_arn = aws_iam_role.ci.arn
}

resource "aws_eks_access_policy_association" "ci" {
  cluster_name  = aws_eks_cluster.this.name
  principal_arn = aws_iam_role.ci.arn
  policy_arn    = "arn:${local.partition}:eks::aws:cluster-access-policy/AmazonEKSEditPolicy"
  access_scope {
    type       = "namespace"
    namespaces = ["relay"]
  }
}

output "ci_role_arn" {
  description = "Set as the GitHub repository variable AWS_CI_ROLE_ARN"
  value       = aws_iam_role.ci.arn
}
