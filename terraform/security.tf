resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "Public ALB for relay"
  vpc_id      = aws_vpc.this.id
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from clients"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP, redirected to HTTPS only"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
}

# The ALB may only talk to the nodes, on the NodePort.
resource "aws_vpc_security_group_egress_rule" "alb_to_nodes" {
  security_group_id            = aws_security_group.alb.id
  description                  = "Forward to the relay NodePort"
  referenced_security_group_id = aws_security_group.nodes.id
  from_port                    = var.app_node_port
  to_port                      = var.app_node_port
  ip_protocol                  = "tcp"
}

resource "aws_security_group" "nodes" {
  name        = "${var.name}-nodes"
  description = "EKS worker nodes"
  vpc_id      = aws_vpc.this.id
}

# Bug fix: this rule allowed 8080, but the ALB targets the NodePort (30080).
# Every health check would have failed and the service would have been
# unreachable on day one.
resource "aws_vpc_security_group_ingress_rule" "nodes_from_alb" {
  security_group_id            = aws_security_group.nodes.id
  description                  = "relay NodePort from the ALB"
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = var.app_node_port
  to_port                      = var.app_node_port
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "nodes_self" {
  security_group_id            = aws_security_group.nodes.id
  description                  = "Node to node (pod networking)"
  referenced_security_group_id = aws_security_group.nodes.id
  ip_protocol                  = "-1"
}

# Removed: SSH from 0.0.0.0/0 and from the bastion. Access is via SSM.

# Nodes need outbound for ECR, STS, the managed DB and S3 (via NAT/endpoint).
# Tighten to the DB security group and VPC endpoints once those IDs are known.
resource "aws_vpc_security_group_egress_rule" "nodes_out" {
  security_group_id = aws_security_group.nodes.id
  description       = "Outbound via NAT / VPC endpoints"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}
