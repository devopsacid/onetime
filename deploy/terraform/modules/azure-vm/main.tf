# One Azure Linux VM with a separate managed data disk. One instance only: the database is SQLite on that disk.
#
# Changing the image or other user data replaces the VM (custom_data forces a new VM). Terraform detaches the data disk
# first and attaches it to the new VM, which mounts the existing filesystem. The static public IP stays.
#
# REQUIRED before such an apply: deallocate the old VM, so the app stops cleanly before its disk is detached:
#   az vm deallocate --resource-group <rg> --name <name>
# (Terraform would otherwise detach the disk from the running VM.) "terraform plan" shows the replacement
# ("must be replaced") before you apply.

locals {
  tags = merge({ "app" = "onetime" }, var.tags)
  # LUN 0, by the udev links of the Azure Ubuntu images (SCSI and NVMe).
  data_devices = ["/dev/disk/azure/scsi1/lun0", "/dev/disk/azure/data/by-lun/0"]
}

module "bootstrap" {
  source = "../vm-bootstrap"

  mode               = var.bootstrap_mode
  image              = var.image
  domain             = var.domain
  registry_auth      = var.acr_id == null ? "none" : "acr"
  data_disk_devices  = local.data_devices
  max_stored         = var.max_stored
  env                = var.env
  max_body_bytes     = var.max_body_bytes
  caddy_tls_internal = var.caddy_tls_internal
}

resource "azurerm_public_ip" "this" {
  name                = "${var.name}-ip"
  resource_group_name = var.resource_group_name
  location            = var.location
  allocation_method   = "Static"
  sku                 = "Standard"
  zones               = var.zone == null ? null : [var.zone]
  tags                = local.tags
}

resource "azurerm_network_security_group" "this" {
  name                = "${var.name}-nsg"
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = local.tags

  security_rule {
    name                       = "http-https"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_ranges    = ["80", "443"]
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  dynamic "security_rule" {
    for_each = length(var.ssh_allowed_cidrs) > 0 ? [1] : []
    content {
      name                       = "ssh"
      priority                   = 110
      direction                  = "Inbound"
      access                     = "Allow"
      protocol                   = "Tcp"
      source_port_range          = "*"
      destination_port_range     = "22"
      source_address_prefixes    = var.ssh_allowed_cidrs
      destination_address_prefix = "*"
    }
  }
}

resource "azurerm_network_interface" "this" {
  name                = "${var.name}-nic"
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = local.tags

  ip_configuration {
    name                          = "primary"
    subnet_id                     = var.subnet_id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.this.id
  }
}

resource "azurerm_network_interface_security_group_association" "this" {
  network_interface_id      = azurerm_network_interface.this.id
  network_security_group_id = azurerm_network_security_group.this.id
}

resource "azurerm_managed_disk" "data" {
  name                 = "${var.name}-data"
  resource_group_name  = var.resource_group_name
  location             = var.location
  storage_account_type = var.data_disk_storage_account_type
  create_option        = "Empty"
  disk_size_gb         = var.data_disk_size_gb
  zone                 = var.zone
  tags                 = local.tags

  lifecycle {
    # The database. Remove this guard on purpose if you really want to delete it.
    prevent_destroy = true
  }
}

resource "azurerm_linux_virtual_machine" "this" {
  name                            = var.name
  resource_group_name             = var.resource_group_name
  location                        = var.location
  size                            = var.vm_size
  zone                            = var.zone
  admin_username                  = var.admin_username
  disable_password_authentication = true
  network_interface_ids           = [azurerm_network_interface.this.id]
  custom_data                     = base64encode(module.bootstrap.user_data)
  tags                            = local.tags

  admin_ssh_key {
    username   = var.admin_username
    public_key = var.admin_ssh_public_key
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "StandardSSD_LRS"
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server"
    version   = "latest"
  }

  dynamic "identity" {
    for_each = var.acr_id == null ? [] : [1]
    content {
      type = "SystemAssigned"
    }
  }
}

resource "azurerm_virtual_machine_data_disk_attachment" "data" {
  managed_disk_id    = azurerm_managed_disk.data.id
  virtual_machine_id = azurerm_linux_virtual_machine.this.id
  lun                = 0
  caching            = "None"
}

resource "azurerm_role_assignment" "acr_pull" {
  count                = var.acr_id == null ? 0 : 1
  scope                = var.acr_id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_linux_virtual_machine.this.identity[0].principal_id
}
