variable "name" {
  description = "Name prefix for every resource (lower case, letters, digits, dashes)."
  type        = string
  default     = "onetime"
}

variable "project" {
  description = "Google Cloud project id."
  type        = string
}

variable "zone" {
  description = "Zone for the VM and its persistent disk, e.g. europe-west3-a."
  type        = string
}

variable "network" {
  description = "VPC network (name or self link)."
  type        = string
  default     = "default"
}

variable "subnetwork" {
  description = "Subnetwork (name or self link); null = the network's subnet in the region (auto-mode networks)."
  type        = string
  default     = null
}

variable "machine_type" {
  description = "Machine type (amd64)."
  type        = string
  default     = "e2-small"
}

variable "boot_image" {
  description = "Boot image (Ubuntu 24.04 for the cloud-init in vm-bootstrap)."
  type        = string
  default     = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
}

variable "ssh_allowed_cidrs" {
  description = "CIDRs allowed to reach port 22 (OS Login decides who may log in). Empty = no SSH rule."
  type        = list(string)
  default     = []
}

variable "data_disk_size_gb" {
  description = "Size of the persistent data disk holding the database."
  type        = number
  default     = 10
}

variable "data_disk_type" {
  description = "Persistent disk type of the data disk (never Filestore)."
  type        = string
  default     = "pd-balanced"
}

variable "bootstrap_mode" {
  description = "full = cloud-init installs Docker, the container and Caddy; base = data disk and Docker only (deploy with Ansible)."
  type        = string
  default     = "full"
}

variable "image" {
  description = "Your own onetime image, preferably by digest. Required for bootstrap_mode = full."
  type        = string
  default     = ""
}

variable "domain" {
  description = "Public host name (the host of ONETIME_ORIGIN). Required for bootstrap_mode = full."
  type        = string
  default     = ""
}

variable "artifact_registry_repository" {
  description = "Artifact Registry repository to pull from, as {location, repository} (repository id). Set = the VM's service account gets roles/artifactregistry.reader on it and pulls with registry_auth gar."
  type = object({
    location   = string
    repository = string
  })
  default = null
}

variable "max_stored" {
  description = "ONETIME_MAX_STORED; null for the server default."
  type        = number
  default     = null
}

variable "env" {
  description = "More environment variables for the server."
  type        = map(string)
  default     = {}
}

variable "max_body_bytes" {
  description = "Largest request body Caddy accepts, in bytes (a secret is at most 16 KB + 28 bytes today)."
  type        = number
  default     = 143360
  validation {
    condition     = var.max_body_bytes >= 1024 && floor(var.max_body_bytes) == var.max_body_bytes
    error_message = "max_body_bytes must be a whole number of at least 1024."
  }
}

variable "caddy_tls_internal" {
  description = "Caddy's local CA instead of a public certificate."
  type        = bool
  default     = false
}

variable "labels" {
  description = "Labels for every resource."
  type        = map(string)
  default     = {}
}
