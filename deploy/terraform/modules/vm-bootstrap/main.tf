# Renders cloud-init user data for one onetime host (Ubuntu 24.04). Shared by the aws-vm, azure-vm and gcp-vm modules.
# Nothing secret goes in here: the image is pulled with the VM's own cloud identity.

locals {
  full = var.mode == "full"

  registry_host = local.full ? split("/", var.image)[0] : ""

  env_lines = concat(
    var.max_stored == null ? [] : ["ONETIME_MAX_STORED=${var.max_stored}"],
    ["ONETIME_MAX_FILE_BYTES=${var.max_file_bytes}", "ONETIME_MAX_FILE_TTL=${var.max_file_ttl}"],
    [for k in sort(keys(var.env)) : "${k}=${var.env[k]}"],
  )

  # Largest request body of the app (fileBlobBytes() in src/shared/limits.ts): the file plus 388 bytes of name and type
  # must fit a padded block, the blob is the block plus 30 bytes, never below a text blob (16,418 bytes; also the limit
  # with files off). 262144 -> 262562, 5242880 -> 5243298.
  file_blocks     = [1024, 4096, 16388, 65924, 131460, 262532, 524676, 1048964, 2097540, 4194692, 5243268]
  file_blob_bytes = var.max_file_bytes == 0 ? 16418 : max(16418, [for b in local.file_blocks : b if b >= var.max_file_bytes + 388][0] + 30)
  # Caddy request_body max_size: max_body_bytes, or the largest blob plus 3 % rounded up to the next 100 KiB
  # (307200 by default, 5427200 at 5 MiB, 102400 with files off). Caddy sets no read or upstream timeout by default,
  # so the app's own upload timeout (60 s plus 1 s per 32 KiB above a text blob, 220 s at 5 MiB) applies.
  proxy_body_bytes = var.max_body_bytes != null ? var.max_body_bytes : ceil(local.file_blob_bytes * 103 / 10240000) * 102400

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
        max_body_bytes = local.proxy_body_bytes
        max_file_bytes = var.max_file_bytes
        blob_bytes     = local.file_blob_bytes
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
