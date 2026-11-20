# The onetime Helm chart on an existing cluster. The caller configures the helm provider (see the examples).
# One replica only; the chart refuses anything else. Every upgrade is a short outage by design.

locals {
  chart_path = coalesce(var.chart_path, abspath("${path.module}/../../../helm/onetime"))

  overrides = merge(
    {
      image = merge(
        { repository = var.image_repository },
        var.image_digest != "" ? { digest = var.image_digest } : {},
        var.image_tag != "" ? { tag = var.image_tag } : {},
      )
    },
    { config = { maxFileBytes = var.max_file_bytes, maxFileTtl = var.max_file_ttl } },
    var.host == null ? {} : { ingress = { enabled = true, host = var.host } },
    var.storage_class == null ? {} : { persistence = { storageClass = var.storage_class } },
  )
}

resource "helm_release" "this" {
  name             = var.release_name
  namespace        = var.namespace
  create_namespace = var.create_namespace
  chart            = local.chart_path

  # Helm merges maps across these documents in order; later ones win.
  values = concat(var.base_values, [yamlencode(var.values), yamlencode(local.overrides)])

  wait            = true
  timeout         = var.timeout
  atomic          = false
  cleanup_on_fail = false
  max_history     = 10
}
