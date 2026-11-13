variable "region" {
  type    = string
  default = "eu-west-1"
}

variable "environment" {
  type    = string
  default = "prod"
}

variable "name" {
  type    = string
  default = "relay-prod"
}

variable "kubernetes_version" {
  description = "Pinned EKS version. Upgrade deliberately, not by accident."
  type        = string
  default     = "1.33"
}

variable "cluster_admin_cidrs" {
  description = <<-EOT
    CIDRs allowed to reach the public EKS API endpoint. Empty = private
    endpoint only (CI then needs a runner inside the VPC). Never 0.0.0.0/0.
  EOT
  type        = list(string)
  default     = []

  validation {
    condition     = !contains(var.cluster_admin_cidrs, "0.0.0.0/0")
    error_message = "The EKS API must not be open to the internet."
  }
}

variable "app_node_port" {
  description = "NodePort the relay Service is exposed on (k8s/base/service.yaml)"
  type        = number
  default     = 30080
}

variable "certificate_arn" {
  description = "ACM certificate for the public HTTPS listener"
  type        = string
}

variable "node_instance_type" {
  type    = string
  default = "m6i.large"
}

# The database password is deliberately NOT a Terraform variable. The data
# team owns the database. They (or a rotation Lambda) write the connection
# string into the Secrets Manager secret created in secrets.tf. That keeps it
# out of code, CLI history and Terraform state.
