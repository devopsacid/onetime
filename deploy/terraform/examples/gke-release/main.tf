# Example: the onetime chart on an existing GKE cluster (Standard or Autopilot) with the GKE Ingress, a Google-managed
# certificate and Persistent Disk. The chart's BackendConfig turns off the load balancer's request logging.

terraform {
  required_version = ">= 1.9.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.12"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.3"
    }
  }
  # Remote state: see docs/deploy-terraform.md ("State").
}

provider "google" {
  project = var.project
}

variable "project" {
  description = "Google Cloud project id."
  type        = string
}

variable "location" {
  description = "Location of the cluster (region or zone)."
  type        = string
}

variable "cluster_name" {
  description = "Existing GKE cluster."
  type        = string
}

variable "image_repository" {
  description = "Your image repository in Artifact Registry."
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

data "google_container_cluster" "this" {
  name     = var.cluster_name
  location = var.location
}

data "google_client_config" "this" {}

# A global static IP for the Ingress, so the DNS record stays when the Ingress is recreated.
resource "google_compute_global_address" "ingress" {
  name = "onetime-ip"
}

provider "helm" {
  kubernetes = {
    host                   = "https://${data.google_container_cluster.this.endpoint}"
    cluster_ca_certificate = base64decode(data.google_container_cluster.this.master_auth[0].cluster_ca_certificate)
    token                  = data.google_client_config.this.access_token
  }
}

module "onetime" {
  source = "../../modules/k8s-release"

  image_repository = var.image_repository
  image_digest     = var.image_digest
  host             = var.host
  base_values      = [file("${path.module}/../../../helm/examples/values-gke.yaml")]
  values = {
    ingress = {
      annotations = {
        "kubernetes.io/ingress.global-static-ip-name" = google_compute_global_address.ingress.name
      }
    }
  }
}

output "ingress_ip" {
  description = "Point an A record for the host here; the managed certificate is issued after that."
  value       = google_compute_global_address.ingress.address
}
