variable "mode" {
  description = "\"full\": Docker, the onetime container and Caddy. \"base\": data disk and Docker only; deploy the app later with the Ansible role (deploy/ansible)."
  type        = string
  default     = "full"
  validation {
    condition     = contains(["full", "base"], var.mode)
    error_message = "mode must be \"full\" or \"base\"."
  }
}

variable "image" {
  description = "Your own onetime image (there is no published one), preferably pinned by digest: registry/onetime@sha256:... Required when mode is \"full\"."
  type        = string
  default     = ""
  validation {
    condition     = var.mode != "full" || can(regex("^[a-z0-9.-]+(:[0-9]+)?/[^ ]+$", var.image))
    error_message = "image is required when mode is \"full\" (registry/repository:tag or registry/repository@sha256:...). There is no published image: build your own with ONETIME_ORIGIN=https://<domain>."
  }
}

variable "domain" {
  description = "Public host name. Must equal the host of the ONETIME_ORIGIN the image was built with. Required when mode is \"full\"."
  type        = string
  default     = ""
  validation {
    condition     = var.mode != "full" ? (var.domain == "" || can(regex("^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$", var.domain))) : can(regex("^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$", var.domain))
    error_message = "domain (a lower-case host name such as onetime.example.com) is required when mode is \"full\"."
  }
}

variable "registry_auth" {
  description = "How the VM logs in to pull the image: none (public image), ecr (instance profile + amazon-ecr-credential-helper), gar (VM service account token from the metadata server), acr (managed identity token exchanged at the registry)."
  type        = string
  default     = "none"
  validation {
    condition     = contains(["none", "ecr", "gar", "acr"], var.registry_auth)
    error_message = "registry_auth must be one of none, ecr, gar, acr."
  }
}

variable "data_disk_devices" {
  description = "Device paths that may name the data disk, tried in order (the cloud modules set this). The first block device found is formatted only if it carries no filesystem or partition table."
  type        = list(string)
}

variable "data_mount_path" {
  description = "Where the data disk is mounted and the database lives. /var/lib/onetime is also what the Ansible role's Docker mode uses."
  type        = string
  default     = "/var/lib/onetime"
}

variable "data_disk_wait_seconds" {
  description = "How long the bootstrap waits for the data disk to appear (attachment can lag behind the boot). Without it the bootstrap stops and the app is not started."
  type        = number
  default     = 600
  validation {
    condition     = var.data_disk_wait_seconds >= 5
    error_message = "data_disk_wait_seconds must be at least 5."
  }
}

variable "max_stored" {
  description = "ONETIME_MAX_STORED; null for the server default (20000)."
  type        = number
  default     = null
  validation {
    condition     = var.max_stored == null ? true : (var.max_stored >= 1 && var.max_stored <= 10000000 && floor(var.max_stored) == var.max_stored)
    error_message = "max_stored must be a whole number from 1 to 10000000."
  }
}

variable "env" {
  description = "More environment variables for the server (for example ONETIME_MAX_CONNECTIONS). HOST, PORT and ONETIME_DB are reserved."
  type        = map(string)
  default     = {}
  validation {
    condition = alltrue([
      for k, v in var.env : can(regex("^[A-Za-z_][A-Za-z0-9_]*$", k)) && !contains(["HOST", "PORT", "ONETIME_DB"], k) && !can(regex("[\r\n]", v))
    ])
    error_message = "env names must be shell-style, must not be HOST, PORT or ONETIME_DB, and values must be one line."
  }
}

variable "max_body_bytes" {
  description = "Largest request body Caddy accepts, in bytes. A secret is at most 16 KB + 28 bytes today; the app refuses anything larger with 413 by itself."
  type        = number
  default     = 65536
  validation {
    condition     = var.max_body_bytes >= 1024 && floor(var.max_body_bytes) == var.max_body_bytes
    error_message = "max_body_bytes must be a whole number of at least 1024."
  }
}

variable "caddy_tls_internal" {
  description = "Use Caddy's local CA instead of a public certificate (tests, or no public DNS yet)."
  type        = bool
  default     = false
}
