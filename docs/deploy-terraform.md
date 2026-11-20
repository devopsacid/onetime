# Deploying onetime with Terraform

Modules and examples are in `deploy/terraform/`. Read [deploy-architecture.md](deploy-architecture.md) first.

Marks: **(tested)** = the project ran it (see [What was tested](#what-was-tested)); **(not tested)** = it did not.

## Layout

| Path | What it is |
|---|---|
| `modules/vm-bootstrap` | cloud-init user data for one Ubuntu 24.04 host: finds the data disk, formats it **only if blank**, mounts it at `/var/lib/onetime`, installs Docker and Caddy, pulls your image with the VM's own cloud identity, runs it under `onetime.service` with the `compose.yaml` hardening as system user `onetime`, Caddy in front without request or error logs. `mode = "base"` stops after the disk and Docker, for the Ansible role. |
| `modules/aws-vm` | EC2 instance, encrypted EBS data volume, Elastic IP, security group (80/443 open, 22 only from listed CIDRs), IMDSv2 with hop limit 1 (containers cannot reach instance credentials), optional instance profile for ECR pulls |
| `modules/azure-vm` | Linux VM (SSH key only), managed data disk on LUN 0, static public IP, NSG, optional system-assigned identity with AcrPull on your registry |
| `modules/gcp-vm` | Compute Engine VM (Shielded VM, OS Login), persistent data disk, static IP, firewall rules, own service account, optional `roles/artifactregistry.reader` on your repository |
| `modules/k8s-release` | `helm_release` of `deploy/helm/onetime` on an existing cluster; the caller configures the helm provider |
| `examples/aws-vm`, `azure-vm`, `gcp-vm` | one VM each, image from ECR / ACR / Artifact Registry |
| `examples/eks-release`, `aks-release`, `gke-release` | the chart on an existing cluster, using `deploy/helm/examples/values-<cloud>.yaml` as base values |
| `examples/k8s-kubeconfig` | the chart on any cluster from a kubeconfig (on-prem, k3s, kind) |

Not created on purpose: Kubernetes clusters (use the official EKS/AKS/GKE modules), container registries (one CLI command, see [deploy-helm.md](deploy-helm.md)), DNS records (point an A record at the `public_ip` output) and certificates (Caddy on the VMs, ACM / cert-manager / Google-managed certificates on the clusters).

Every data disk has `prevent_destroy = true`. `terraform destroy` therefore stops at the disk until you remove that guard on purpose.

## Prerequisites

- Terraform 1.9 or newer. Provider constraints: modules `aws >= 6, < 7`, `azurerm >= 4, < 6`, `google >= 6, < 9`, `helm >= 3, < 4`; examples pin `aws ~> 6.73`, `azurerm ~> 5.14`, `google ~> 8.12`, `helm ~> 3.3` and carry `.terraform.lock.hcl`.
- Cloud credentials from your environment only (AWS profile/SSO, `az login`, `gcloud auth application-default login`). Nothing in this code holds a credential, and the VMs pull images with their own identity, so no registry password ends up in state or user data.
- Your own image pushed to a registry, referenced by digest (see [deploy-helm.md](deploy-helm.md), "Build and push the image").
- For the cluster examples: the cluster with its add-ons (EBS CSI + AWS Load Balancer Controller; Application Gateway for Containers + cert-manager; GKE with HTTP load balancing), and `kubelogin` for AKS clusters with Microsoft Entra ID.

## Usage

```sh
cd deploy/terraform/examples/aws-vm
cp terraform.tfvars.example terraform.tfvars    # edit; *.tfvars is git-ignored
terraform init
terraform plan
terraform apply
```

Then point the DNS record of the domain at the `public_ip` output. Caddy retries until the name resolves and then gets a certificate.

To manage the app with Ansible instead (for example systemd mode, or updates without replacing the VM), set `bootstrap_mode = "base"` and use the `ansible_inventory` output with `deploy/ansible`. Both use `/var/lib/onetime`, the user `onetime` and the unit `onetime.service`, so Ansible's Docker mode can also take over a `full` host.

## Upgrade

**VMs.** Changing `image` (or anything else in the user data) **replaces the VM**: the old one is removed first, the data disk is detached and attached to the new VM, which finds the existing filesystem and does not format it. The static IP stays. This is a short outage by design.

- AWS: `user_data_replace_on_change`; the volume attachment uses `stop_instance_before_detaching`, so the app stops cleanly.
- Azure: `custom_data` forces a new VM, and Terraform would detach the disk from the running VM. **Deallocate the old VM first** (this is the required procedure; it is simpler than switching to Ansible for updates): run `terraform plan`, and when it shows the VM "must be replaced", run `az vm deallocate --resource-group <rg> --name <name>`, then `terraform apply`. The deallocation shuts the VM down, which stops onetime cleanly before the disk is detached.
- GCP: `replace_triggered_by` on the user-data checksum.

New base images (AMI, Ubuntu image) are ignored after creation, so a new Ubuntu release does not replace the VM by itself. Unattended upgrades on Ubuntu keep packages patched.

**Clusters.** Change `image_digest` and apply: Helm upgrades the StatefulSet, the old pod stops before the new one starts.

> **ingress-nginx warning for `k8s-release`.** Terraform does not show Helm's NOTES, so the chart's warning does not reach you here. If the Ingress is served by ingress-nginx (on-prem values, kind, or the AKS application routing add-on), the controller itself must run with `disable-access-log: "true"` and `error-log-level: "crit"` in its ConfigMap; otherwise every restart of onetime writes the reveal path with the secret id and the client IP to the controller log. Check with `kubectl -n ingress-nginx get configmap ingress-nginx-controller -o jsonpath='{.data}'`. See [deploy-helm.md](deploy-helm.md).

## Data disk guard and body limit

The bootstrap is one script with `set -e`: if the data disk does not appear within `data_disk_wait_seconds` (default 600), nothing else is installed or started. `onetime.service` also runs `ExecStartPre=mountpoint -q /var/lib/onetime`, and `onetime-run` checks the mount again, so the app never starts on the root disk.

The file limit is `max_file_bytes` (ONETIME_MAX_FILE_BYTES, default 262144, 0 to 5242880, 0 = files off) and the file life `max_file_ttl` (ONETIME_MAX_FILE_TTL, default 3600, 60 to 604800) on vm-bootstrap and the three VM modules; both go into `/etc/onetime/env`, and `env` may not set them. Caddy's body limit is derived from the file limit: the largest blob plus 3 %, rounded up to the next 100 KiB (307200 by default, 1126400 at 1 MiB, 5427200 at 5 MiB, 102400 with files off; see [deploy-architecture.md](deploy-architecture.md#5-tls-and-request-size)). `max_body_bytes` (default `null`) overrides it; a value below the largest blob fails the plan (a precondition on the user data). Caddy has no read or upstream timeout by default, so the app's own upload timeout (220 s at 5 MiB) is the only one. Above 1 MiB, each upload takes about three times the blob in memory, up to `ONETIME_MAX_UPLOADS` (default 16) at once: on a small VM set `env = { ONETIME_MAX_UPLOADS = "4" }`.

These inputs are part of the user data, so changing them replaces the VM like an image change (see [Upgrade](#upgrade)). Updating to this version of the modules does too, because the env file and the Caddyfile change (the derived limit replaces the old 143360 default).

`k8s-release` has `max_file_bytes` and `max_file_ttl` as well (same defaults and checks); they are passed as `config.maxFileBytes` and `config.maxFileTtl` and win over `base_values` and `values`. The chart derives the ingress body limit and timeouts from them ([deploy-helm.md](deploy-helm.md#large-files)).

## Backup and restore

You may not need backups. A backup or disk snapshot keeps encrypted blobs of secrets that are later revealed, and restoring it makes those links work again until they expire. If you take snapshots of the data disk (AWS Backup, Azure Backup, GCE snapshot schedules), keep the retention short and say so on your privacy page. Stop the app before a snapshot (`sudo systemctl stop onetime`), or accept a crash-consistent copy. For clusters see [deploy-helm.md](deploy-helm.md).

## Logging

The VM modules put Caddy in front with no `log` directive and with handler errors (`http.log.error`, which carry the request URI and client IP) and TLS handshake errors (`http.stdlib`, client IPs) excluded. No cloud load balancer is involved on the VMs. Do not add one with access logs on. For the clusters, the values files keep ALB, Application Gateway for Containers and GKE load balancer logging off; see [deploy-helm.md](deploy-helm.md), "Logging".

Boot diagnostics / serial console logs (Azure boot diagnostics, the GCE serial port, the EC2 console output) show cloud-init output. It contains no secrets and no request paths.

## State

The examples keep local state. For real use put state in a remote backend with locking and encryption at rest, for example an S3 bucket with a DynamoDB table or S3 native locking, an Azure Storage container, or a GCS bucket:

```hcl
terraform {
  backend "s3" {
    bucket       = "my-tfstate"
    key          = "onetime/aws-vm.tfstate"
    region       = "eu-central-1"
    use_lockfile = true
    encrypt      = true
  }
}
```

State holds no secrets from this code (no passwords, keys or tokens), but it does hold resource ids and addresses; restrict access anyway.

## Platform notes

- **Fargate, Container Apps, Cloud Run, Lightsail containers: not supported**, see the verdict in [deploy-architecture.md](deploy-architecture.md). They need a Postgres store; the owner decided not to ship an ephemeral-storage Fargate module.
- **arm64**: set an arm64 instance type, AMI parameter or image and build a multi-arch image **(not tested)**.
- **IPv6**: the AWS security group allows 80/443 over IPv6; the modules do not assign IPv6 addresses.

## What was tested

Run on 2026-11-20 with Terraform 1.17.2, tflint 0.66.0 (rulesets aws 0.50.0, azurerm 0.33.0, google 0.41.0), trivy 0.69.1, shellcheck 0.10.0, cloud-init 26.2 (Ubuntu 24.04 package), Caddy 2 (`caddy:2-alpine`) and providers aws 6.73.0, azurerm 5.14.0, google 8.12.0, helm 3.3.0.

| Check | Result |
|---|---|
| `terraform fmt -check -recursive` | pass |
| `terraform init -backend=false` + `terraform validate` in all 5 modules and 7 examples | all valid |
| tflint (recommended preset + cloud rulesets) in every module and example | clean (after replacing a retired Azure VM size) |
| `trivy config` | findings accepted by design: public IPs and 0.0.0.0/0 on 80/443 (a public website), unrestricted egress (packages, image pull, ACME), no customer-managed encryption keys (disks are encrypted with provider keys; add CMK if you need it) |
| vm-bootstrap rendered for `none`, `ecr`, `gar`, `acr` and `base` (with `terraform apply` of a provider-less root module) | `cloud-init schema` valid for all five; the generated shell scripts pass shellcheck; the Caddyfiles pass `caddy validate` |
| vm-bootstrap input validation | missing image or domain in `full` mode, and `env.HOST`, are refused at plan time |
| `examples/k8s-kubeconfig` applied to a throwaway kind cluster (image tag, `values-kind-test.yaml`) | release deployed, round trip through ingress-nginx ok (create, status, reveal once, 404, 413), a second `plan` showed no changes |
| vm-bootstrap end to end | see below |

**vm-bootstrap end to end.** The rendered user data (`registry_auth = "none"`, `caddy_tls_internal = true`, `max_stored = 777`) was run by cloud-init 26.2 in a throwaway privileged Ubuntu 24.04 container with systemd, a NoCloud seed, a 256 MB loop device standing in for the data disk (linked as `/dev/disk/by-id/google-onetime-data`) and a local registry serving the image. It is not a real VM: no cloud metadata, no cloud identity, no udev disk naming.

| Check | Result |
|---|---|
| First boot, blank disk | all cloud-init stages exit 0; disk formatted ext4, in `/etc/fstab` by UUID with `nofail`, mounted at `/var/lib/onetime` (owner `onetime`, mode 0700); `docker`, `onetime` and `caddy` active |
| Container | read-only root, `CapDrop [ALL]`, `no-new-privileges`, user `onetime` (996:992), port `127.0.0.1:8080`, `local` log driver; one start-up line with `max 777 secrets`; database and WAL 0600 |
| Round trip through Caddy over HTTPS | create 200, status 200, GET reveal 405, POST reveal 200 with the same bytes, second reveal 404; 70 KB body refused (502 from Ubuntu's Caddy 2.6.2); CSP, HSTS, `no-store`, `X-Robots-Tag` from the app |
| Logging | journal (1962 lines) and `/var/log` held no secret id, also not after a reveal sent while `onetime` was stopped (502) |
| Replacement boot (new instance id) on the same disk | the filesystem was **not** formatted again (creation time unchanged), mounted from the existing fstab entry; a secret created on the first "VM" was still pending, revealed once (200), then 404 |

Two bootstrap bugs were found and fixed on the way: the schema check caught `defer` rendered as the string `"true"`, and this run showed that Docker stayed stopped when package installation may not start services (`runcmd` now enables Docker and Caddy itself). Two harness issues (missing `lsb_release`, containerd storage on an overlay root) were test-container artefacts.

File limit (added 2026-11-20 with Terraform 1.17.2, no tflint or trivy installed this time): `terraform fmt -check -recursive` passes; `terraform init -backend=false` + `terraform validate` pass in all 5 modules and 7 examples. vm-bootstrap applied in a provider-less root module: the env file holds `ONETIME_MAX_FILE_BYTES` and `ONETIME_MAX_FILE_TTL`, the Caddy limit is 307200 by default, 102400 at 0, 614400 at 262145, 1126400 at 1 MiB and 5427200 at 5242880, and the derived blob and body limit equal the formula over 23 values at every size-class boundary; the rendered 5 MiB Caddyfile passes `caddy validate`. 5242881, -1 and 1.5 are refused at plan time, and `max_body_bytes = 200000` with the default file limit fails the precondition. `k8s-release`: `terraform console` shows `config.maxFileBytes`/`maxFileTtl` in the chart overrides, and a TTL of 10 is refused. No cloud-init end-to-end run for this change.

Not tested: any real AWS, Azure or Google Cloud resource (no plan or apply against a cloud account), the ECR/GAR/ACR pull paths, instance replacement with a real disk detach/attach, the EKS/AKS/GKE examples, remote backends.
