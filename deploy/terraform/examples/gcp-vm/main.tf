# Example: onetime on one Compute Engine VM with a persistent data disk, image from Artifact Registry, Caddy with
# automatic HTTPS. Credentials come from "gcloud auth application-default login" or GOOGLE_APPLICATION_CREDENTIALS.

terraform {
  required_version = ">= 1.9.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.12"
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

variable "zone" {
  description = "Zone, e.g. europe-west3-a."
  type        = string
}

variable "image" {
  description = "Your image in Artifact Registry, by digest: <location>-docker.pkg.dev/<project>/<repository>/onetime@sha256:..."
  type        = string
}

variable "artifact_registry_location" {
  description = "Location of the Artifact Registry repository, e.g. europe-west3."
  type        = string
}

variable "artifact_registry_repository" {
  description = "Repository id in Artifact Registry."
  type        = string
}

variable "domain" {
  description = "Public host name, the host of the ONETIME_ORIGIN the image was built with."
  type        = string
}

variable "ssh_allowed_cidrs" {
  description = "CIDRs allowed to use SSH (35.235.240.0/20 for IAP TCP forwarding)."
  type        = list(string)
  default     = []
}

module "onetime" {
  source = "../../modules/gcp-vm"

  project = var.project
  zone    = var.zone
  image   = var.image
  artifact_registry_repository = {
    location   = var.artifact_registry_location
    repository = var.artifact_registry_repository
  }
  domain            = var.domain
  ssh_allowed_cidrs = var.ssh_allowed_cidrs
}

output "public_ip" {
  description = "Point an A record for the domain here; Caddy then gets the certificate."
  value       = module.onetime.public_ip
}

output "ansible_inventory" {
  description = "Inventory line for deploy/ansible."
  value       = module.onetime.ansible_inventory
}
