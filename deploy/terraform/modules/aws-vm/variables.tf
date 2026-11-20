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

variable "max_body_bytes" {
  description = "Largest request body Caddy accepts, in bytes (a secret is at most 16 KB + 28 bytes today)."
  type        = number
  default     = 65536
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

variable "tags" {
  description = "Tags for every resource."
  type        = map(string)
  default     = {}
}
