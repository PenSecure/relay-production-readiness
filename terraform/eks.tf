data "aws_iam_policy_document" "cluster_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cluster" {
  name               = "${var.name}-cluster"
  assume_role_policy = data.aws_iam_policy_document.cluster_assume.json
}

resource "aws_iam_role_policy_attachment" "cluster" {
  role       = aws_iam_role.cluster.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonEKSClusterPolicy"
}

resource "aws_cloudwatch_log_group" "eks" {
  # EKS writes control-plane logs to this fixed name.
  name              = "/aws/eks/${var.name}/cluster"
  retention_in_days = 90
  kms_key_id        = aws_kms_key.this.arn
}

resource "aws_eks_cluster" "this" {
  name     = var.name
  version  = var.kubernetes_version
  role_arn = aws_iam_role.cluster.arn

  vpc_config {
    subnet_ids              = aws_subnet.private[*].id
    endpoint_private_access = true
    # Public endpoint only if explicitly allow-listed. Previously 0.0.0.0/0.
    endpoint_public_access = length(var.cluster_admin_cidrs) > 0
    public_access_cidrs    = length(var.cluster_admin_cidrs) > 0 ? var.cluster_admin_cidrs : null
  }

  access_config {
    authentication_mode = "API"
  }

  encryption_config {
    resources = ["secrets"]
    provider {
      key_arn = aws_kms_key.this.arn
    }
  }

  enabled_cluster_log_types = ["api", "audit", "authenticator"]

  depends_on = [
    aws_iam_role_policy_attachment.cluster,
    aws_cloudwatch_log_group.eks,
  ]
}

# IRSA: lets a Kubernetes ServiceAccount assume an IAM role (iam_app.tf).
data "tls_certificate" "oidc" {
  url = aws_eks_cluster.this.identity[0].oidc[0].issuer
}

resource "aws_iam_openid_connect_provider" "eks" {
  url             = aws_eks_cluster.this.identity[0].oidc[0].issuer
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.oidc.certificates[0].sha1_fingerprint]
}

# ------------------------------------------------------------------ nodes

data "aws_iam_policy_document" "node_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "node" {
  name               = "${var.name}-node"
  assume_role_policy = data.aws_iam_policy_document.node_assume.json
}

# The node role has only what a node needs. The app's S3 permissions moved
# to an IRSA role (iam_app.tf). Previously every pod on every node inherited
# s3:* and secretsmanager:* on *.
resource "aws_iam_role_policy_attachment" "node" {
  for_each = toset([
    "AmazonEKSWorkerNodePolicy",
    "AmazonEKS_CNI_Policy",
    "AmazonEC2ContainerRegistryReadOnly",
    "AmazonSSMManagedInstanceCore", # SSM Session Manager replaces SSH and the bastion
  ])
  role       = aws_iam_role.node.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/${each.value}"
}

resource "aws_launch_template" "nodes" {
  name_prefix = "${var.name}-nodes-"
  # No key_name: no SSH. Use `aws ssm start-session`.

  vpc_security_group_ids = [
    aws_security_group.nodes.id,
    aws_eks_cluster.this.vpc_config[0].cluster_security_group_id,
  ]

  # IMDSv2 only, hop limit 1: pods cannot reach the node's instance
  # credentials (an SSRF in any pod used to reach the node role).
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size = 50
      volume_type = "gp3"
      encrypted   = true
      kms_key_id  = aws_kms_key.this.arn
    }
  }
}

resource "aws_eks_node_group" "this" {
  cluster_name    = aws_eks_cluster.this.name
  node_group_name = "${var.name}-default"
  node_role_arn   = aws_iam_role.node.arn
  # Both AZs. Previously one subnet, so a single AZ outage was a full outage
  # even though the ALB spanned two.
  subnet_ids     = aws_subnet.private[*].id
  instance_types = [var.node_instance_type]

  scaling_config {
    desired_size = 3
    min_size     = 3
    max_size     = 6
  }

  update_config {
    max_unavailable = 1
  }

  launch_template {
    id      = aws_launch_template.nodes.id
    version = aws_launch_template.nodes.latest_version
  }

  depends_on = [aws_iam_role_policy_attachment.node]
}
