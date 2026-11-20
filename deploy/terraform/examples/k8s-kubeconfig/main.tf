# Example: the onetime chart on any cluster reachable with a kubeconfig (on-prem, k3s, kind).
# The project ran this example against a throwaway kind cluster (docs/deploy-terraform.md, "What was tested").

terraform {
  required_version = ">= 1.9.0"
  required_providers {
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.3"
    }
  }
  # Remote state: see docs/deploy-terraform.md ("State").
}

variable "kubeconfig_path" {
  description = "Path to the kubeconfig."
  type        = string
  default     = "~/.kube/config"
}

variable "kube_context" {
  description = "Context in the kubeconfig (null = current context)."
  type        = string
  default     = null
}

variable "values_file" {
  description = "Base values, e.g. ../../../helm/examples/values-onprem-ingress-nginx.yaml."
  type        = string
}

variable "image_repository" {
  description = "Your image repository."
  type        = string
}

variable "image_digest" {
  description = "Image digest (sha256:...); or set image_tag."
  type        = string
  default     = ""
}

variable "image_tag" {
  description = "Image tag, if no digest."
  type        = string
  default     = ""
}

variable "host" {
  description = "Public host name, the host of the ONETIME_ORIGIN the image was built with."
  type        = string
}

provider "helm" {
  kubernetes = {
    config_path    = pathexpand(var.kubeconfig_path)
    config_context = var.kube_context
  }
}

module "onetime" {
  source = "../../modules/k8s-release"

  image_repository = var.image_repository
  image_digest     = var.image_digest
  image_tag        = var.image_tag
  host             = var.host
  base_values      = [file(var.values_file)]
}

output "release" {
  description = "Release name and namespace."
  value       = "${module.onetime.release_name} in ${module.onetime.namespace}"
}
