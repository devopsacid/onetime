# Deployment architecture

This page says what the deploy code under `deploy/helm/`, `deploy/ansible/` and `deploy/terraform/` assumes, and which platforms it supports. The tool guides are:

- [deploy-helm.md](deploy-helm.md): the Helm chart for Kubernetes (generic, AKS, EKS, GKE).
- [deploy-ansible.md](deploy-ansible.md): the Ansible role for a plain Linux host (Docker or systemd, optional Caddy or nginx).
- [deploy-terraform.md](deploy-terraform.md): Terraform modules for a single VM on AWS, Azure and Google Cloud, and for the Helm release on an existing cluster.

[self-hosting.md](self-hosting.md) explains the server itself (settings, exit codes, proxies). Read it first.

## Facts every deployment must respect

### 1. One instance, one local disk

The database is one SQLite file. The server holds an exclusive lock on it for its whole life; a second server on the same file exits with code 3.

- **Exactly one replica.** No autoscaling, no rolling update that starts the new instance before the old one has stopped. Every update therefore has a short downtime (a few seconds). That is by design.
- **Block or local storage only**: a local disk, an EBS volume, an Azure managed disk, a Google persistent disk, a Longhorn or Ceph RBD block volume, a `local-path` volume. **Never a network filesystem**: no NFS, EFS, Azure Files, SMB, Filestore, CephFS or `ReadWriteMany` volumes. SQLite's WAL mode does not work over a network filesystem, and the lock cannot be relied on there.
- How the code enforces it:
  - Helm: a StatefulSet (at most one pod with that identity; on an update the old pod is gone before the new one starts). The chart refuses to render when `replicaCount` is not 1, both in `values.schema.json` and in the template.
  - Ansible and the VMs: one systemd unit per host, `Restart=on-failure` with `RestartPreventExitStatus=2 3`, so a locked database or a bad configuration does not loop.

### 2. No published image

The site origin (`ONETIME_ORIGIN`) and the optional operator name, contact and indexable flag are baked in at build time. Every operator builds and pushes their own image (or, for systemd, their own bundle). Image repository and tag or digest are **required inputs** in the chart, the role and every Terraform module; nothing defaults to a public image. Pin a digest in production.

The image holds nothing secret (the operator values are shown on the privacy page), so a public registry repository is acceptable if you prefer one.

### 3. The container

| Property | Value |
|---|---|
| User | uid 1000 / gid 1000 in the image (the Ansible Docker mode runs it as a dedicated host system user instead, see [deploy-ansible.md](deploy-ansible.md)) |
| Root filesystem | read-only works; nothing is written outside the database folder |
| Capabilities | none needed; `no-new-privileges` |
| Port | plain HTTP on 8080 |
| Health | `GET /healthz` answers 200 `ok` (it runs `SELECT 1` on the database) |
| Exit codes | 0 clean stop, 1 other start error, 2 bad configuration, 3 database locked |
| Stop | SIGTERM, requests in flight finish within 8 s; give it at least 10 s |
| Environment | `HOST`, `PORT`, `ONETIME_DB`, `ONETIME_MAX_STORED`; every tool also takes a free-form map for new variables (for example `ONETIME_MAX_CONNECTIONS`) |

### 4. Logging: nothing in front of the app may log request paths

Request paths contain secret ids (`/api/secrets/<id>/reveal`). The app writes no request lines. Everything in front of it must not either:

| Component | Default access logging | What the deploy code does |
|---|---|---|
| Caddy | access log off unless a `log` directive exists, **but handler errors (`http.log.error`) are logged with the request URI and client IP**, e.g. a reveal during a restart | no `log` directive, plus a global `log default { exclude http.log.error http.stdlib }` (Ansible role, VM cloud-init). Tested: without the exclusion a reveal path reached the journal, with it nothing |
| nginx | on | `access_log off` in the http context and the server, global `error_log ... crit`, distribution default site removed (Ansible) |
| ingress-nginx (also AKS application routing) | on, and the error log (level `notice`) writes request lines | per Ingress `enable-access-log: "false"` **and** controller config `disable-access-log: "true"`, `error-log-level: crit` (required, see the on-prem values). Tested in kind: with the annotation alone a restart logged `request: "POST /api/secrets/<id>/reveal"` with the client IP; with the controller settings nothing |
| Traefik (k3s) | off unless `accesslog` is configured | nothing to switch off; the docs say not to enable it. **Not tested**: whether Traefik's own error log writes request paths during an app restart was not probed |
| AWS ALB | off (`access_logs.s3.enabled=false`) | set explicitly, also `connection_logs.s3.enabled=false` |
| Azure Application Gateway, Application Gateway for Containers | only through Azure diagnostic settings | the docs say not to enable the access-log category (`ApplicationGatewayAccessLog`, or the access log of Application Gateway for Containers), and to check Azure Policy that adds diagnostic settings |
| GKE Ingress (external Application Load Balancer) | **on** for backends created by Ingress | the chart creates a `BackendConfig` with `logging.enable: false` and attaches it to the Service (GKE values) |

Container log collection (Container Insights, Cloud Logging, CloudWatch/Fluent Bit) picks up whatever a proxy writes to stdout. That is why the proxy itself must be quiet, not only its log file.

The app never reads `Host` or `X-Forwarded-*`, so no forwarding headers or trusted-proxy settings are needed. Security headers (CSP, HSTS, caching) come from the app and must not be rewritten, removed or cached by anything in front.

### 5. TLS and request size

TLS terminates in front of the app (Caddy, nginx, an ingress controller or a cloud load balancer). Browsers only allow the page's encryption in a secure context, so plain HTTP works only on `localhost`.

The proxy limits request bodies, and the limit must follow the file limit (`ONETIME_MAX_FILE_BYTES`, default 262,144, ceiling 5,242,880). The largest body is the encrypted blob of the largest file: 262,562 bytes for the default, 5,243,298 at the ceiling, 16,418 (a secret text) with files off; the table in [self-hosting.md](self-hosting.md#reverse-proxy-and-https) has the steps in between. A proxy limit below the blob makes the proxy refuse the largest allowed file (the page then shows an upload error). The app also enforces its own limit (413), so a proxy without a body limit (AWS ALB, Application Gateway for Containers, GKE Ingress) is still safe.

Every deploy tool has the file limit as a variable and derives the proxy settings from it, so they are never hard-coded:

- **Body limit** = the largest blob plus 3 %, rounded up to the next 100 KiB (102,400 bytes): 307,200 (300 KiB) by default, 5,427,200 (5300 KiB) at 5 MiB, 102,400 with files off.
- **Proxy read/send timeout** = the app's own upload timeout (60 s plus 1 s per 32 KiB of blob above a text blob: 68 s by default, 220 s at 5 MiB) plus 10 s, rounded up to 10 s: 80 s by default, 230 s at 5 MiB, 70 s with files off. A proxy that streams the body (Caddy, or nginx without request buffering) waits for the answer during the whole upload, so a shorter timeout would cut off a large file on a slow line. Body timeouts *between two reads* stay at 30 s (nginx `client_body_timeout`): a slow upload still sends data.

| Tool | File limit | Body limit (override, empty or null = derived) | Timeout (override) | Used for |
|---|---|---|---|---|
| Helm | `config.maxFileBytes` (262144), `config.maxFileTtl` (3600) | `ingress.maxBodyBytes` | `ingress.proxyTimeoutSeconds` | ingress-nginx `proxy-body-size`, `proxy-read-timeout`, `proxy-send-timeout` (unless set as annotations); the Traefik Middleware in `values-k3s-traefik.yaml`; GKE BackendConfig `timeoutSec` |
| Ansible | `onetime_max_file_bytes` (262144), `onetime_max_file_ttl` (3600) | `onetime_max_body_bytes` | `onetime_proxy_timeout` | Caddy `request_body max_size`; nginx `client_max_body_size`, `proxy_read_timeout`, `proxy_send_timeout` |
| Terraform (VMs) | `max_file_bytes` (262144), `max_file_ttl` (3600) on vm-bootstrap and the three VM modules | `max_body_bytes` | none (Caddy has no default timeout) | Caddy `request_body max_size` |
| Terraform (`k8s-release`) | `max_file_bytes`, `max_file_ttl`, passed to the chart | chart values (`values`) | chart values | as Helm |
| `compose.yaml`, `deploy/onetime.service` | `ONETIME_MAX_FILE_BYTES`, `ONETIME_MAX_FILE_TTL` (shell environment / `Environment=`) | | | |
| `deploy/Caddyfile.example`, `deploy/nginx.conf.example` | | `300KiB` / `300k`, edit by hand (the comments list 1 MiB, 5 MiB and files off) | nginx `80s` | |

A body limit override below the largest blob is refused (Helm rendering fails, the Ansible assert fails, the Terraform user-data precondition fails). Memory grows with the file limit too: the server holds each upload about three times, up to `ONETIME_MAX_UPLOADS` (default 16) at once, so with files above 1 MiB lower `ONETIME_MAX_UPLOADS` or give the process more memory ([self-hosting.md](self-hosting.md#files)).

On ALB, Application Gateway for Containers and the GKE Ingress there is no body limit to set; the app's own limit applies. Their timeouts: see [deploy-helm.md](deploy-helm.md#large-files).

### 6. Backups bring back used links

A backup keeps encrypted blobs of secrets that are later revealed or expire. Restoring it makes links that were revealed after the backup work **again**, until they expire. Prefer no backups (a lost database only loses links nobody opened), or keep them short-lived and never restore an old one over a running service without telling the users. The same applies to disk snapshots.

## Platform support

"Supported" means the storage and single-instance rules can hold and the deploy code targets it. It does not mean tested: the last column says what the project actually ran (details per tool in each guide).

| Platform | Verdict | How | Storage | Tested by the project |
|---|---|---|---|---|
| Plain Linux host (Debian, Ubuntu, RHEL family) | supported | Ansible role, Docker or systemd mode, optional Caddy or nginx | local disk | Ansible role run against Debian 13 and Rocky 9 systemd containers (see [deploy-ansible.md](deploy-ansible.md)); not on a real host |
| Generic Kubernetes (on-prem, k3s, kind) | supported | Helm chart | RWO block or local volume: `local-path`, OpenEBS LocalPV, Longhorn RWO, Ceph RBD | Helm chart installed in a local kind cluster with ingress-nginx and `local-path`; full API round trip through the ingress |
| AKS | supported | Helm chart (Terraform `aks-release` example), Application Gateway for Containers | Azure Disk (`managed-csi`) | rendered and schema-checked only |
| EKS on EC2 nodes | supported | Helm chart | EBS (EBS CSI driver, `gp3`) | rendered and schema-checked only |
| GKE Standard and Autopilot | supported | Helm chart | Persistent Disk (`standard-rwo`) | rendered and schema-checked only |
| AWS EC2 (a Lightsail instance works the same way, set up by hand) | supported | Terraform `aws-vm` + cloud-init or Ansible | EBS data volume | `terraform validate`; the shared cloud-init run end to end in an Ubuntu 24.04 container (see [deploy-terraform.md](deploy-terraform.md)) |
| Azure VM | supported | Terraform `azure-vm` + cloud-init or Ansible | managed data disk | `terraform validate`; shared cloud-init as above |
| Google Compute Engine VM | supported | Terraform `gcp-vm` + cloud-init or Ansible | persistent data disk | `terraform validate`; shared cloud-init as above |
| EKS on Fargate | **not supported** | none | Fargate pods can mount EFS only (network filesystem) | n/a |
| ECS on Fargate | **not supported** (see below) | none | durable storage is EFS only; EBS volumes are per task | n/a |
| Azure Container Apps, App Service | **not supported** | none | Azure Files only; App Service overlaps old and new container | n/a |
| AKS virtual nodes (ACI) | **not supported** | none | Azure Files only | n/a |
| Google Cloud Run | **not supported** | none | in-memory, Cloud Storage FUSE or NFS (Filestore); new revisions overlap the old | n/a |
| Lightsail container service | **not supported** | none | no persistent volumes | n/a |
| Any platform with `ReadWriteMany` or NFS storage | **not supported** | none | network filesystem | n/a |

### Verdict on Fargate and similar serverless container platforms

Not supported, and the deploy code ships nothing for them. The reasons:

1. **Durable storage is a network filesystem.** On ECS Fargate and EKS Fargate the only storage that outlives a task is EFS (NFS). The storage rule forbids it, and the server cannot detect every network-share setup, so a misconfiguration would fail silently (two writers, a corrupted WAL, or a revealed secret coming back).
2. **ECS-managed EBS volumes are per task.** ECS can attach an EBS volume to a Fargate task, but a service creates a new volume for every task it starts and removes it when the task stops; it can only be seeded from a snapshot. A seed snapshot is a backup: it would bring back secrets revealed after it was taken (fact 6). Without a seed, the volume is simply ephemeral.
3. **An ephemeral variant would be technically possible but changes the product.** One task (`desired_count = 1`, `maximumPercent = 100`, `minimumHealthyPercent = 0`, so the old task stops before the new one starts) with the database on the task's own ephemeral storage keeps both SQLite rules: local disk, one writer. But every deploy, crash, scaling event and every Fargate platform retirement of the task would silently delete all unopened secrets. Whether that is acceptable is a product decision; the owner decided against it (see below). The same reasoning applies to Cloud Run and Azure Container Apps with in-memory or ephemeral storage, where new revisions additionally overlap the old one.
4. **What would make them supported:** a Postgres store (the `SecretStore` interface in `src/worker/store.ts` leaves room for it; `insertIfBelowCap` would need an advisory lock). With Postgres (RDS, Azure Database for PostgreSQL, Cloud SQL), the app becomes stateless and can run with several replicas on Fargate, Container Apps or Cloud Run, and the Helm chart could drop the single-replica rule. A future in-memory or Redis store could be another option for these platforms; it would need its own answer to the one-time and durability rules.

The owner decided on 2026-11-20 not to ship an ephemeral-storage Fargate module.

## Design choices in the deploy code

- **StatefulSet, not Deployment.** With one replica, a StatefulSet replaces its pod only after the old one is gone, also when a node stops answering (the pod stays until the node is confirmed gone or someone force-deletes it). A Deployment with `Recreate` would also stop first, but a Deployment controller creates a replacement while a pod on a lost node may still be running.
- **Database in a subfolder of the volume** (`/data/db/onetime.db` in Kubernetes). A volume root often has group bits (fsGroup) or mode 0777 (`local-path`); the server creates its own folder with mode 0700 and stays quiet about permissions.
- **No PodDisruptionBudget.** With one replica a PDB either blocks node drains forever or does nothing. A drain is a short outage, like an update.
- **Clusters, registries and DNS are not created.** The Terraform code deploys onto an existing cluster and takes an image reference. Creating clusters is a large, opinionated domain (use the official EKS/AKS/GKE modules); a registry is one CLI command, shown in the guides; DNS is one record pointing at the output address. Certificates come from Caddy (VMs), cert-manager (generic Kubernetes, AKS), ACM (EKS) or Google-managed certificates (GKE).
- **The VMs use Docker from cloud-init**, with the same hardening as `compose.yaml`, behind Caddy with automatic HTTPS. The Ansible role can take over later (for example to switch to systemd mode).

## Not automated yet

The checks that proved the logging and storage behaviour were run by hand with throwaway rigs and are not in the repository or CI. Follow-up work:

1. **kind log check**: build the image, install the chart with `values-kind-test.yaml` behind ingress-nginx, run the API round trip, restart the pod while reveal requests arrive, and fail if the controller log contains a secret id (once with the controller defaults to prove the check catches the leak, once with `disable-access-log` and `error-log-level: crit`).
2. **Ansible containers**: privileged Debian 13 and Rocky 9 containers with systemd as PID 1; run the playbook twice (second run `changed=0`), `--check`, the round trip through Caddy and nginx, and a journal / log grep for the secret id, also while the app is stopped.
3. **cloud-init NoCloud**: render `vm-bootstrap`, boot a privileged Ubuntu 24.04 systemd container with a NoCloud seed, a loop device as data disk and a local registry; check the first boot, a replacement boot on the same disk (no reformat, data kept) and a boot without the disk (the app must not start).
