# One Compute Engine VM with a separate persistent data disk. One instance only: the database is SQLite on that disk.
#
# A change of the image or other user data replaces the VM (replace_triggered_by below). The old VM is deleted first,
# which detaches the disk; the new VM attaches it and mounts the existing filesystem. The static IP stays.

locals {
  labels      = merge({ app = "onetime" }, var.labels)
  device_name = "onetime-data"
  region      = join("-", slice(split("-", var.zone), 0, 2))
}

module "bootstrap" {
  source = "../vm-bootstrap"

  mode               = var.bootstrap_mode
  image              = var.image
  domain             = var.domain
  registry_auth      = var.artifact_registry_repository == null ? "none" : "gar"
  data_disk_devices  = ["/dev/disk/by-id/google-${local.device_name}"]
  max_stored         = var.max_stored
  env                = var.env
  max_body_bytes     = var.max_body_bytes
  caddy_tls_internal = var.caddy_tls_internal
}

resource "terraform_data" "bootstrap" {
  input = module.bootstrap.user_data_sha256
}

resource "google_service_account" "this" {
  project      = var.project
  account_id   = "${var.name}-vm"
  display_name = "onetime VM"
}

resource "google_artifact_registry_repository_iam_member" "reader" {
  count      = var.artifact_registry_repository == null ? 0 : 1
  project    = var.project
  location   = var.artifact_registry_repository.location
  repository = var.artifact_registry_repository.repository
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.this.email}"
}

resource "google_compute_address" "this" {
  project = var.project
  name    = "${var.name}-ip"
  region  = local.region
}

resource "google_compute_firewall" "web" {
  project       = var.project
  name          = "${var.name}-web"
  network       = var.network
  direction     = "INGRESS"
  source_ranges = ["0.0.0.0/0"]
  target_tags   = [var.name]

  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }
}

resource "google_compute_firewall" "ssh" {
  count         = length(var.ssh_allowed_cidrs) > 0 ? 1 : 0
  project       = var.project
  name          = "${var.name}-ssh"
  network       = var.network
  direction     = "INGRESS"
  source_ranges = var.ssh_allowed_cidrs
  target_tags   = [var.name]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

resource "google_compute_disk" "data" {
  project = var.project
  name    = "${var.name}-data"
  zone    = var.zone
  type    = var.data_disk_type
  size    = var.data_disk_size_gb
  labels  = local.labels

  lifecycle {
    # The database. Remove this guard on purpose if you really want to delete it.
    prevent_destroy = true
  }
}

resource "google_compute_instance" "this" {
  project      = var.project
  name         = var.name
  zone         = var.zone
  machine_type = var.machine_type
  tags         = [var.name]
  labels       = local.labels

  boot_disk {
    initialize_params {
      image = var.boot_image
      size  = 20
      type  = "pd-balanced"
    }
  }

  attached_disk {
    source      = google_compute_disk.data.id
    device_name = local.device_name
  }

  network_interface {
    network    = var.network
    subnetwork = var.subnetwork
    access_config {
      nat_ip = google_compute_address.this.address
    }
  }

  metadata = {
    user-data              = module.bootstrap.user_data
    enable-oslogin         = "TRUE"
    block-project-ssh-keys = "TRUE"
  }

  service_account {
    email  = google_service_account.this.email
    scopes = ["cloud-platform"]
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  allow_stopping_for_update = true

  lifecycle {
    replace_triggered_by = [terraform_data.bootstrap]
    ignore_changes       = [boot_disk[0].initialize_params[0].image]
  }
}
