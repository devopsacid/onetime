output "user_data" {
  description = "cloud-init user data (#cloud-config), plain text."
  value       = local.user_data
}

output "user_data_sha256" {
  description = "Checksum of the user data; the VM modules replace the VM when it changes."
  value       = sha256(local.user_data)
}
