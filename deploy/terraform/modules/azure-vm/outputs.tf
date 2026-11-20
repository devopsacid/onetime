output "public_ip" {
  description = "Static public IP. Point the DNS record of the domain here (A record)."
  value       = azurerm_public_ip.this.ip_address
}

output "vm_id" {
  description = "VM resource id."
  value       = azurerm_linux_virtual_machine.this.id
}

output "data_disk_id" {
  description = "Managed disk with the database."
  value       = azurerm_managed_disk.data.id
}

output "ansible_inventory" {
  description = "Inventory line for deploy/ansible."
  value       = "onetime-1 ansible_host=${azurerm_public_ip.this.ip_address} ansible_user=${var.admin_username}"
}
