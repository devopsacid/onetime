# Example: onetime on one EC2 instance with an EBS data volume, image from ECR, Caddy with automatic HTTPS.
# Credentials come from your AWS environment (profile, SSO, environment variables); nothing is stored here.

terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.73"
    }
  }
  # Remote state: see docs/deploy-terraform.md ("State").
}

provider "aws" {
  region = var.region
}

variable "region" {
  description = "AWS region."
  type        = string
}

variable "subnet_id" {
  description = "Public subnet for the instance."
  type        = string
}

variable "image" {
  description = "Your image in ECR, by digest: <account>.dkr.ecr.<region>.amazonaws.com/onetime@sha256:..."
  type        = string
}

variable "ecr_repository_arn" {
  description = "ARN of the ECR repository holding the image."
  type        = string
}

variable "domain" {
  description = "Public host name, the host of the ONETIME_ORIGIN the image was built with."
  type        = string
}

variable "key_name" {
  description = "EC2 key pair for SSH (optional)."
  type        = string
  default     = null
}

variable "ssh_allowed_cidrs" {
  description = "CIDRs allowed to use SSH."
  type        = list(string)
  default     = []
}

module "onetime" {
  source = "../../modules/aws-vm"

  subnet_id           = var.subnet_id
  image               = var.image
  ecr_repository_arns = [var.ecr_repository_arn]
  domain              = var.domain
  key_name            = var.key_name
  ssh_allowed_cidrs   = var.ssh_allowed_cidrs
}

output "public_ip" {
  description = "Point an A record for the domain here; Caddy then gets the certificate."
  value       = module.onetime.public_ip
}

output "ansible_inventory" {
  description = "Inventory line for deploy/ansible."
  value       = module.onetime.ansible_inventory
}
