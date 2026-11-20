# Example: the onetime chart on an existing EKS cluster (EC2 nodes, EBS CSI driver, AWS Load Balancer Controller).
# Not EKS Fargate: Fargate pods can only mount EFS, which the storage rule forbids.

terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.73"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.3"
    }
  }
  # Remote state: see docs/deploy-terraform.md ("State").
}

provider "aws" {
  region = var.region
}

variable "region" {
  description = "AWS region of the cluster."
  type        = string
}

variable "cluster_name" {
  description = "Existing EKS cluster."
  type        = string
}

variable "image_repository" {
  description = "Your image repository in ECR."
  type        = string
}

variable "image_digest" {
  description = "Image digest (sha256:...)."
  type        = string
}

variable "host" {
  description = "Public host name, the host of the ONETIME_ORIGIN the image was built with."
  type        = string
}

variable "acm_certificate_arn" {
  description = "ACM certificate for the host (the ALB terminates TLS)."
  type        = string
}

variable "vpc_cidr" {
  description = "VPC CIDR; the ALB (target-type ip) connects from it, so the NetworkPolicy allows it."
  type        = string
}

data "aws_eks_cluster" "this" {
  name = var.cluster_name
}

data "aws_eks_cluster_auth" "this" {
  name = var.cluster_name
}

provider "helm" {
  kubernetes = {
    host                   = data.aws_eks_cluster.this.endpoint
    cluster_ca_certificate = base64decode(data.aws_eks_cluster.this.certificate_authority[0].data)
    token                  = data.aws_eks_cluster_auth.this.token
  }
}

module "onetime" {
  source = "../../modules/k8s-release"

  image_repository = var.image_repository
  image_digest     = var.image_digest
  host             = var.host
  base_values      = [file("${path.module}/../../../helm/examples/values-eks.yaml")]
  values = {
    ingress = {
      annotations = {
        "alb.ingress.kubernetes.io/certificate-arn" = var.acm_certificate_arn
      }
    }
    networkPolicy = {
      ingressFrom = [{ ipBlock = { cidr = var.vpc_cidr } }]
    }
  }
}
