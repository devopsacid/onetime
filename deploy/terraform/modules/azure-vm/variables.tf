variable "name" {
  description = "Name prefix for every resource."
  type        = string
  default     = "onetime"
}

variable "resource_group_name" {
  description = "Existing resource group."
  type        = string
}

variable "location" {
  description = "Azure region, e.g. westeurope."
  type        = string
}

variable "subnet_id" {
  description = "Existing subnet for the VM's network interface."
  type        = string
}

variable "zone" {
  description = "Availability zone for the VM, its disk and the public IP (null = regional)."
  type        = string
  default     = null
}

variable "vm_size" {
  description = "VM size (amd64)."
  type        = string
  default     = "Standard_B2als_v2"
}

variable "admin_username" {
  description = "Admin user (SSH key only, no password)."
  type        = string
  default     = "azureuser"
}

variable "admin_ssh_public_key" {
  description = "SSH public key for the admin user (required by Azure for Linux VMs)."
  type        = string
}

variable "ssh_allowed_cidrs" {
  description = "CIDRs allowed to reach port 22. Empty = no SSH rule."
  type        = list(string)
  default     = []
}

variable "data_disk_size_gb" {
  description = "Size of the managed data disk holding the database."
  type        = number
  default     = 4
}

variable "data_disk_storage_account_type" {
  description = "Managed disk type of the data disk (never a file share)."
  type        = string
  default     = "StandardSSD_LRS"
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

variable "acr_id" {
  description = "Resource id of an Azure Container Registry. Set = the VM gets a system-assigned identity with AcrPull on it and pulls with registry_auth acr."
  type        = string
  default     = null
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

variable "tags" {
  description = "Tags for every resource."
  type        = map(string)
  default     = {}
}
