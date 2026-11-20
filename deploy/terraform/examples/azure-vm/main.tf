# Example: onetime on one Azure VM with a managed data disk, image from ACR, Caddy with automatic HTTPS.
# Creates its own resource group and network. Credentials come from "az login" or the ARM_* environment variables.

terraform {
  required_version = ">= 1.9.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.14"
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

variable "location" {
  description = "Azure region."
  type        = string
  default     = "westeurope"
}

variable "image" {
  description = "Your image in ACR, by digest: <registry>.azurecr.io/onetime@sha256:..."
  type        = string
}

variable "acr_id" {
  description = "Resource id of the ACR holding the image."
  type        = string
}

variable "domain" {
  description = "Public host name, the host of the ONETIME_ORIGIN the image was built with."
  type        = string
}

variable "admin_ssh_public_key" {
  description = "SSH public key for the admin user."
  type        = string
}

variable "ssh_allowed_cidrs" {
  description = "CIDRs allowed to use SSH."
  type        = list(string)
  default     = []
}

resource "azurerm_resource_group" "this" {
  name     = "onetime"
  location = var.location
}

resource "azurerm_virtual_network" "this" {
  name                = "onetime-vnet"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  address_space       = ["10.42.0.0/24"]
}

resource "azurerm_subnet" "this" {
  name                 = "onetime"
  resource_group_name  = azurerm_resource_group.this.name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = ["10.42.0.0/26"]
}

module "onetime" {
  source = "../../modules/azure-vm"

  resource_group_name  = azurerm_resource_group.this.name
  location             = azurerm_resource_group.this.location
  subnet_id            = azurerm_subnet.this.id
  zone                 = "1"
  image                = var.image
  acr_id               = var.acr_id
  domain               = var.domain
  admin_ssh_public_key = var.admin_ssh_public_key
  ssh_allowed_cidrs    = var.ssh_allowed_cidrs
}

output "public_ip" {
  description = "Point an A record for the domain here; Caddy then gets the certificate."
  value       = module.onetime.public_ip
}

output "ansible_inventory" {
  description = "Inventory line for deploy/ansible."
  value       = module.onetime.ansible_inventory
}
