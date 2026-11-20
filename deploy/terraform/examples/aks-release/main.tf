# Example: the onetime chart on an existing AKS cluster (Azure Disk, Application Gateway for Containers, cert-manager).
# Not AKS virtual nodes (ACI): they only offer Azure Files.

terraform {
  required_version = ">= 1.9.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.14"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.3"
    }
  }
  # Remote state: see docs/deploy-terraform.md ("State").
}

provider "azurerm" {
  features {}
  subscription_id = var.subscription_id
}

variable "subscription_id" {
  description = "Azure subscription id."
  type        = string
}

variable "resource_group_name" {
  description = "Resource group of the cluster."
  type        = string
}

variable "cluster_name" {
  description = "Existing AKS cluster."
  type        = string
}

variable "image_repository" {
  description = "Your image repository in ACR (attached to the cluster)."
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

data "azurerm_kubernetes_cluster" "this" {
  name                = var.cluster_name
  resource_group_name = var.resource_group_name
}

# Microsoft Entra ID clusters (local accounts disabled): kubelogin turns the Azure CLI login into a cluster token.
# 6dae42f8-... is the fixed application id of the AKS server.
provider "helm" {
  kubernetes = {
    host                   = data.azurerm_kubernetes_cluster.this.kube_config[0].host
    cluster_ca_certificate = base64decode(data.azurerm_kubernetes_cluster.this.kube_config[0].cluster_ca_certificate)
    exec = {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "kubelogin"
      args        = ["get-token", "--login", "azurecli", "--server-id", "6dae42f8-4368-4678-94ff-3960e28e3630"]
    }
  }
}

module "onetime" {
  source = "../../modules/k8s-release"

  image_repository = var.image_repository
  image_digest     = var.image_digest
  host             = var.host
  base_values      = [file("${path.module}/../../../helm/examples/values-aks.yaml")]
}
