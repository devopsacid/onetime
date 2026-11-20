output "public_ip" {
  description = "Static external IP. Point the DNS record of the domain here (A record)."
  value       = google_compute_address.this.address
}

output "instance_id" {
  description = "Instance id."
  value       = google_compute_instance.this.id
}

output "data_disk_id" {
  description = "Persistent disk with the database."
  value       = google_compute_disk.data.id
}

output "service_account_email" {
  description = "Service account of the VM."
  value       = google_service_account.this.email
}

output "ansible_inventory" {
  description = "Inventory line for deploy/ansible (log in with OS Login)."
  value       = "onetime-1 ansible_host=${google_compute_address.this.address}"
}
