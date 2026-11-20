output "release_name" {
  description = "Helm release name."
  value       = helm_release.this.name
}

output "namespace" {
  description = "Namespace of the release."
  value       = helm_release.this.namespace
}

output "chart_version" {
  description = "Chart version that was deployed."
  value       = helm_release.this.metadata.version
}
