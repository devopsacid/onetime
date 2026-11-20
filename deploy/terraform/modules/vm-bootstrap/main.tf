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
    devices    = join(" ", var.data_disk_devices)
    mount_path = var.data_mount_path
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
      content     = file("${path.module}/files/onetime-run.sh")
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
      content     = file("${path.module}/files/onetime.service")
    },
    {
      # Written after the caddy package is installed, so it replaces the package's default site.
      path        = "/etc/caddy/Caddyfile"
      permissions = "0644"
      defer       = true
      content = templatefile("${path.module}/files/Caddyfile.tftpl", {
        domain       = var.domain
        tls_internal = var.caddy_tls_internal
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
      [{
        path        = "/usr/local/sbin/onetime-data-disk"
        permissions = "0755"
        defer       = false
        content     = local.data_disk_script
      }],
      [for f in local.files_full : f if local.full],
    )
    runcmd = concat(
      [
        ["/usr/local/sbin/onetime-data-disk"],
        ["sh", "-c", "id -u onetime >/dev/null 2>&1 || useradd --system --no-create-home --home-dir ${var.data_mount_path} --shell /usr/sbin/nologin onetime"],
        ["chown", "onetime:onetime", var.data_mount_path],
        ["chmod", "0700", var.data_mount_path],
      ],
      local.full ? [
        ["/usr/local/sbin/onetime-pull"],
        ["systemctl", "daemon-reload"],
        ["systemctl", "enable", "--now", "onetime.service"],
        ["systemctl", "reload-or-restart", "caddy.service"],
      ] : [],
    )
  }

  user_data = "#cloud-config\n${yamlencode(local.cloud_config)}"
}
