variable "name" {
  description = "Name prefix for every resource."
  type        = string
  default     = "onetime"
}

variable "subnet_id" {
  description = "Public subnet for the instance (it needs a route to the internet for packages, the image and ACME)."
  type        = string
}

variable "instance_type" {
  description = "Instance type (amd64; arm64 types also need an arm64 image and ami_ssm_parameter)."
  type        = string
  default     = "t3.small"
}

variable "ami_ssm_parameter" {
  description = "SSM parameter with the Ubuntu 24.04 AMI id."
  type        = string
  default     = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

variable "ami_id" {
  description = "Use this AMI instead of the SSM parameter (must be Ubuntu 24.04 or compatible with the cloud-init in vm-bootstrap)."
  type        = string
  default     = ""
}

variable "key_name" {
  description = "EC2 key pair for SSH (optional; Ansible needs SSH)."
  type        = string
  default     = null
}

variable "ssh_allowed_cidrs" {
  description = "CIDRs allowed to reach port 22. Empty = no SSH rule."
  type        = list(string)
  default     = []
}

variable "data_disk_size_gb" {
  description = "Size of the EBS data volume holding the database."
  type        = number
  default     = 4
}

variable "data_disk_type" {
  description = "EBS type of the data volume."
  type        = string
  default     = "gp3"
}

variable "root_disk_size_gb" {
  description = "Root volume size."
  type        = number
  default     = 16
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

variable "ecr_repository_arns" {
  description = "ECR repositories the instance may pull from. Non-empty = an instance profile with pull rights and registry_auth ecr."
  type        = list(string)
  default     = []
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

variable "max_file_bytes" {
  description = "ONETIME_MAX_FILE_BYTES: largest file in bytes, 0..5242880 (5 MiB); 0 turns files off. Caddy's body limit follows from it. Each upload is held about 3 times in memory, up to ONETIME_MAX_UPLOADS (default 16) at once: with files above 1 MiB on a small VM, set ONETIME_MAX_UPLOADS lower in env."
  type        = number
  default     = 262144
  validation {
    condition     = var.max_file_bytes >= 0 && var.max_file_bytes <= 5242880 && floor(var.max_file_bytes) == var.max_file_bytes
    error_message = "max_file_bytes must be a whole number from 0 to 5242880 (0 turns files off)."
  }
}

variable "max_file_ttl" {
  description = "ONETIME_MAX_FILE_TTL: longest life of a file in seconds, 60..604800. Default 1 hour, like the hosted service."
  type        = number
  default     = 3600
  validation {
    condition     = var.max_file_ttl >= 60 && var.max_file_ttl <= 604800 && floor(var.max_file_ttl) == var.max_file_ttl
    error_message = "max_file_ttl must be a whole number of seconds from 60 to 604800."
  }
}

variable "max_body_bytes" {
  description = "Largest request body Caddy accepts, in bytes. null = derived from max_file_bytes: the largest blob plus 3 %, rounded up to the next 100 KiB (307200 by default, 5427200 at 5 MiB, 102400 with files off). A number overrides it and must be at least the largest blob (262562 for the default; docs/self-hosting.md)."
  type        = number
  default     = null
  validation {
    condition     = var.max_body_bytes == null ? true : (var.max_body_bytes >= 16418 && floor(var.max_body_bytes) == var.max_body_bytes)
    error_message = "max_body_bytes must be null (derived from max_file_bytes) or a whole number of at least 16418."
  }
}

variable "caddy_tls_internal" {
  description = "Caddy's local CA instead of a public certificate."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tags for every resource."
  type        = map(string)
  default     = {}
}
