# One EC2 instance with a separate EBS data volume. One instance only: the database is SQLite on that volume.
#
# Replacing the instance (a new image or other user data) stops it first, detaches the volume, and attaches it to the
# new instance, which mounts the existing filesystem. The Elastic IP stays, so DNS does not change.

data "aws_ssm_parameter" "ami" {
  count = var.ami_id == "" ? 1 : 0
  name  = var.ami_ssm_parameter
}

data "aws_subnet" "this" {
  id = var.subnet_id
}

locals {
  tags = merge({ "app" = "onetime" }, var.tags)
  ami  = var.ami_id != "" ? var.ami_id : nonsensitive(data.aws_ssm_parameter.ami[0].value)
  # Nitro instances expose EBS volumes as NVMe devices named after the volume id.
  data_devices = [
    "/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${replace(aws_ebs_volume.data.id, "-", "")}",
    "/dev/xvdf",
  ]
}

module "bootstrap" {
  source = "../vm-bootstrap"

  mode               = var.bootstrap_mode
  image              = var.image
  domain             = var.domain
  registry_auth      = length(var.ecr_repository_arns) > 0 ? "ecr" : "none"
  data_disk_devices  = local.data_devices
  max_stored         = var.max_stored
  env                = var.env
  caddy_tls_internal = var.caddy_tls_internal
}

resource "aws_security_group" "this" {
  name_prefix = "${var.name}-"
  description = "onetime: HTTP and HTTPS from anywhere, SSH only from the listed ranges"
  vpc_id      = data.aws_subnet.this.vpc_id
  tags        = merge(local.tags, { Name = var.name })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "http" {
  for_each          = toset(["80", "443"])
  security_group_id = aws_security_group.this.id
  description       = "HTTP(S) for Caddy (80 is needed for ACME and the redirect)"
  ip_protocol       = "tcp"
  from_port         = tonumber(each.value)
  to_port           = tonumber(each.value)
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "http_v6" {
  for_each          = toset(["80", "443"])
  security_group_id = aws_security_group.this.id
  description       = "HTTP(S) for Caddy over IPv6"
  ip_protocol       = "tcp"
  from_port         = tonumber(each.value)
  to_port           = tonumber(each.value)
  cidr_ipv6         = "::/0"
}

resource "aws_vpc_security_group_ingress_rule" "ssh" {
  for_each          = toset(var.ssh_allowed_cidrs)
  security_group_id = aws_security_group.this.id
  description       = "SSH"
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
  cidr_ipv4         = each.value
}

resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.this.id
  description       = "Packages, image pull, ACME"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# --- optional instance profile for ECR pulls ---
data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "ecr_pull" {
  count = length(var.ecr_repository_arns) > 0 ? 1 : 0
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
    resources = var.ecr_repository_arns
  }
}

resource "aws_iam_role" "this" {
  count              = length(var.ecr_repository_arns) > 0 ? 1 : 0
  name_prefix        = "${var.name}-"
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy" "ecr_pull" {
  count  = length(var.ecr_repository_arns) > 0 ? 1 : 0
  name   = "ecr-pull"
  role   = aws_iam_role.this[0].id
  policy = data.aws_iam_policy_document.ecr_pull[0].json
}

resource "aws_iam_instance_profile" "this" {
  count       = length(var.ecr_repository_arns) > 0 ? 1 : 0
  name_prefix = "${var.name}-"
  role        = aws_iam_role.this[0].name
  tags        = local.tags
}

# --- data volume and instance ---
resource "aws_ebs_volume" "data" {
  availability_zone = data.aws_subnet.this.availability_zone
  size              = var.data_disk_size_gb
  type              = var.data_disk_type
  encrypted         = true
  tags              = merge(local.tags, { Name = "${var.name}-data" })

  lifecycle {
    # The database. Remove this guard on purpose if you really want to delete it.
    prevent_destroy = true
  }
}

resource "aws_instance" "this" {
  ami                         = local.ami
  instance_type               = var.instance_type
  subnet_id                   = var.subnet_id
  vpc_security_group_ids      = [aws_security_group.this.id]
  key_name                    = var.key_name
  iam_instance_profile        = length(var.ecr_repository_arns) > 0 ? aws_iam_instance_profile.this[0].name : null
  user_data                   = module.bootstrap.user_data
  user_data_replace_on_change = true

  metadata_options {
    http_tokens = "required"
    # 1 hop: containers on the Docker bridge cannot reach the instance metadata (and its credentials).
    http_put_response_hop_limit = 1
    http_endpoint               = "enabled"
  }

  root_block_device {
    volume_size = var.root_disk_size_gb
    volume_type = "gp3"
    encrypted   = true
  }

  tags = merge(local.tags, { Name = var.name })

  lifecycle {
    ignore_changes = [ami]
  }
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/xvdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.this.id
  # Stop the instance before detaching, so the app shuts down cleanly and the filesystem is unmounted.
  stop_instance_before_detaching = true
}

resource "aws_eip" "this" {
  domain   = "vpc"
  instance = aws_instance.this.id
  tags     = merge(local.tags, { Name = var.name })
}
