output "user_data" {
  description = "cloud-init user data (#cloud-config), plain text."
  value       = local.user_data
  precondition {
    condition     = local.proxy_body_bytes >= local.file_blob_bytes
    error_message = "max_body_bytes is below the largest blob of max_file_bytes (${local.file_blob_bytes} bytes): Caddy would refuse the largest allowed file. Set it to null to derive it, or lower max_file_bytes."
  }
}

output "proxy_body_bytes" {
  description = "Caddy's request body limit in bytes (max_body_bytes, or derived from max_file_bytes)."
  value       = local.proxy_body_bytes
}

output "user_data_sha256" {
  description = "Checksum of the user data; the VM modules replace the VM when it changes."
  value       = sha256(local.user_data)
}
