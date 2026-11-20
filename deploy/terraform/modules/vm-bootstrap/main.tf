# Renders cloud-init user data for one onetime host (Ubuntu 24.04). Shared by the aws-vm, azure-vm and gcp-vm modules.
# Nothing secret goes in here: the image is pulled with the VM's own cloud identity.

locals {
  full = var.mode == "full"

  registry_host = local.full ? split("/", var.image)[0] : ""

  env_lines = concat(
    var.max_stored == null ? [] : ["ONETIME_MAX_STORED=${var.max_stored}"],
    [for k in sort(keys(var.env)) : "${k}=${var.env[k]}"],
  )

  data_disk_script = templatefile("${path.module}/files/onetime-data-disk.sh.tftpl", {
    devices      = join(" ", var.data_disk_devices)
    mount_path   = var.data_mount_path
    wait_seconds = var.data_disk_wait_seconds
  })

  # Every entry has the same attributes, so Terraform keeps "defer" a boolean (cloud-init rejects the string "true").
  files_full = [
    {
      path        = "/etc/onetime/image"
      permissions = "0644"
      defer       = false
      content     = "${var.image}\n"
    },
    {
      path        = "/etc/onetime/env"
      permissions = "0600"
      defer       = false
      content     = join("", [for l in local.env_lines : "${l}\n"])
    },
    {
      path        = "/usr/local/sbin/onetime-run"
      permissions = "0755"
      defer       = false
      content     = templatefile("${path.module}/files/onetime-run.sh.tftpl", { mount_path = var.data_mount_path })
    },
    {
      path        = "/usr/local/sbin/onetime-pull"
      permissions = "0755"
      defer       = false
      content = templatefile("${path.module}/files/onetime-pull.sh.tftpl", {
        registry_auth = var.registry_auth
        registry_host = local.registry_host
      })
    },
    {
      path        = "/etc/systemd/system/onetime.service"
      permissions = "0644"
      defer       = false
      content     = templatefile("${path.module}/files/onetime.service.tftpl", { mount_path = var.data_mount_path })
    },
    {
      # Written after the caddy package is installed, so it replaces the package's default site.
      path        = "/etc/caddy/Caddyfile"
      permissions = "0644"
      defer       = true
      content = templatefile("${path.module}/files/Caddyfile.tftpl", {
        domain         = var.domain
        tls_internal   = var.caddy_tls_internal
        max_body_bytes = var.max_body_bytes
      })
    },
  ]

  cloud_config = {
    package_update  = true
    package_upgrade = false
    packages = concat(
      ["docker.io"],
      local.full ? ["caddy"] : [],
      local.full && var.registry_auth == "ecr" ? ["amazon-ecr-credential-helper"] : [],
    )
    write_files = concat(
      [
        {
          path        = "/usr/local/sbin/onetime-data-disk"
          permissions = "0755"
          defer       = false
          content     = local.data_disk_script
        },
        {
          path        = "/usr/local/sbin/onetime-bootstrap"
          permissions = "0755"
          defer       = false
          content = templatefile("${path.module}/files/onetime-bootstrap.sh.tftpl", {
            mount_path = var.data_mount_path
            full       = local.full
          })
        },
      ],
      [for f in local.files_full : f if local.full],
    )
    # One wrapper with "set -e": cloud-init's runcmd would carry on after a failed step.
    runcmd = [["/usr/local/sbin/onetime-bootstrap"]]
  }

  user_data = "#cloud-config\n${yamlencode(local.cloud_config)}"
}
