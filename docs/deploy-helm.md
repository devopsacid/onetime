# Deploying onetime with Helm (Kubernetes)

The chart is in `deploy/helm/onetime/`, example values in `deploy/helm/examples/`. Read [deploy-architecture.md](deploy-architecture.md) first: one replica, block or local storage, no request logs anywhere.

Marks: **(tested)** = the project ran it (see [What was tested](#what-was-tested)); **(not tested)** = it did not.

## What the chart creates

| Object | Notes |
|---|---|
| StatefulSet | exactly one pod; rendering fails for any other `replicaCount`. Pod: uid/gid 1000, read-only root, no capabilities, `RuntimeDefault` seccomp, no service account token, `enableServiceLinks: false`, startup/liveness/readiness probes on `/healthz`, 15 s grace period |
| PVC | from `volumeClaimTemplates` (kept on `helm uninstall`), or `persistence.existingClaim`. `ReadWriteMany` is refused |
| Service + headless Service | port 80 to 8080 |
| Ingress | optional: class, host, TLS secret, optional cert-manager issuer, free annotations |
| ServiceAccount | `automountServiceAccountToken: false` |
| NetworkPolicy | optional: only the listed peers may reach port 8080; all egress denied (the app makes no outbound connections). Rendering fails when it is enabled with an empty `ingressFrom` |
| BackendConfig, ManagedCertificate, FrontendConfig | optional, GKE only |
| helm test pod | runs `wget /healthz` from the app image itself |

The database is `/data/db/onetime.db` in the volume. The server creates `/data/db` with mode 0700 itself, so it does not matter that a volume root has group bits (fsGroup) or mode 0777 (`local-path`).

## Prerequisites

- Kubernetes 1.27 or newer, Helm 3.
- A StorageClass with **block or local** volumes (EBS `gp3`, Azure Disk `managed-csi`, GCE PD `standard-rwo`, `local-path`, Longhorn RWO, Ceph RBD). Never NFS, EFS, Azure Files, Filestore, CephFS or an RWX class.
- An ingress controller or cloud load balancer that terminates TLS, and that you can configure to keep **no access log and no error log with request lines** (see [Logging](#logging)).
- A container registry the cluster can pull from.

## Build and push the image

There is no published image. The origin is baked in, so build one per public address:

```sh
docker build --build-arg ONETIME_ORIGIN=https://onetime.example.com \
  --build-arg ONETIME_OPERATOR_NAME="Example Ltd" --build-arg ONETIME_OPERATOR_CONTACT=privacy@example.com \
  -t registry.example.com/onetime:2026-11-20 .
docker push registry.example.com/onetime:2026-11-20
docker buildx imagetools inspect registry.example.com/onetime:2026-11-20   # prints the digest
```

Use the digest in `image.digest`. Creating a registry is one command per cloud (not done by this repository):

```sh
aws ecr create-repository --repository-name onetime --image-scanning-configuration scanOnPush=true
az acr create -g <rg> -n <registry> --sku Basic && az aks update -g <rg> -n <cluster> --attach-acr <registry>
gcloud artifacts repositories create onetime --repository-format=docker --location=europe-west3
```

The build and push commands above follow `docs/self-hosting.md` (the build is tested there); pushing to ECR, ACR or Artifact Registry **(not tested)**.

## Install

```sh
helm install onetime deploy/helm/onetime -n onetime --create-namespace \
  -f deploy/helm/examples/values-onprem-ingress-nginx.yaml \
  --set image.repository=registry.example.com/onetime \
  --set image.digest=sha256:<digest> \
  --set ingress.host=onetime.example.com
helm test onetime -n onetime
```

`ingress.host` must be the host of the `ONETIME_ORIGIN` the image was built with, or the links point elsewhere.

Example values:

| File | Platform | Ingress / TLS | Storage | Tested |
|---|---|---|---|---|
| `values-kind-test.yaml` | local kind cluster | ingress-nginx, self-signed secret | `standard` (local-path) | **installed, round trip (tested)** |
| `values-onprem-ingress-nginx.yaml` | generic / on-prem | ingress-nginx + cert-manager | Longhorn | rendered only |
| `values-k3s-traefik.yaml` | k3s | Traefik + cert-manager, body-limit Middleware | `local-path` | rendered only |
| `values-aks.yaml` | AKS | Application Gateway for Containers + cert-manager | Azure Disk `managed-csi` | rendered only |
| `values-eks.yaml` | EKS on EC2 nodes | AWS Load Balancer Controller (ALB), ACM certificate | EBS `gp3` | rendered only |
| `values-gke.yaml` | GKE Standard/Autopilot | GKE Ingress, Google-managed certificate | PD `standard-rwo` | rendered only |

"Rendered only" means `helm lint --strict`, `helm template` and kubeconform (including the CRD schemas) passed; nothing was installed on that platform.

## Platform notes

### Generic Kubernetes, on-prem, k3s

- ingress-nginx: the per-Ingress annotation `nginx.ingress.kubernetes.io/enable-access-log: "false"` is **not enough**. In the controller ConfigMap set `disable-access-log: "true"` and `error-log-level: "crit"`. Without the second one, every pod restart writes lines such as `connect() failed ... client: <IP> ... request: "POST /api/secrets/<id>/reveal HTTP/2.0"` to the controller log; the project's kind test produced exactly that line. Optional: `hsts: "false"`, so the app's own HSTS header is the only one.
- ingress-nginx stays the tested default. Upstream ingress-nginx is retired (announced by Kubernetes SIG Network in November 2025, no maintenance after March 2026); Traefik is the suggested alternative for new clusters (`values-k3s-traefik.yaml`, **not tested**).
- For ingress-nginx classes (a class name containing `nginx`, `webapprouting.kubernetes.azure.com`, or any `nginx.ingress.kubernetes.io/` annotation) `helm install` and `helm upgrade` print a warning with the two controller settings and how to check them.
- Traefik writes access logs only when `accessLog` is configured; leave it off. Whether Traefik's error log writes request paths during an app restart was **not tested**. The k3s example adds a `buffering` Middleware limited to `ingress.maxBodyBytes`; the chart passes Ingress annotation values through `tpl`, so the middleware reference uses the release namespace **(not tested)**.
- `local-path` volumes live on one node; the pod is pinned there. Longhorn: RWO volumes only (Longhorn RWX uses NFS).
- `persistence.accessModes: [ReadWriteOncePod]` is stricter (one pod, not one node) where the CSI driver supports it; `local-path` does not.

### AKS

- Storage: Azure Disk (`managed-csi`, or a ZRS class). Never `azurefile-*`.
- Ingress: the example uses Application Gateway for Containers (ALB Controller). It writes access logs only through an Azure diagnostic setting: do not enable its access-log category, and check Azure Policy assignments that add diagnostic settings automatically.
- The application routing add-on (managed ingress-nginx) is not used in the example: the add-on manages the controller configuration, and the leak above happens unless `error-log-level` is `crit` and access logs are off. If you can set both, it works like any ingress-nginx.
- Container Insights collects every container's stdout: another reason the proxy itself must be quiet.
- Image pull: `az aks update --attach-acr`.
- Not supported: AKS virtual nodes (ACI), which offer only Azure Files.

### EKS

- EC2 node groups (managed, self-managed or Auto Mode) with the EBS CSI driver and a `gp3` StorageClass.
- The AWS Load Balancer Controller creates an ALB; TLS uses an ACM certificate (`alb.ingress.kubernetes.io/certificate-arn`). The example sets `access_logs.s3.enabled=false` and `connection_logs.s3.enabled=false` explicitly (both are off by default).
- ALB has no request-body limit setting, so `ingress.maxBodyBytes` has no effect there. The app refuses bodies over its own limit (16 KB + 28 bytes today) with 413 by itself.
- `target-type: ip` means the ALB connects from VPC addresses: the NetworkPolicy allows the VPC CIDR. NetworkPolicy needs the VPC CNI network policy agent.
- Not supported: EKS on Fargate (EFS only).

### GKE

- **GKE turns on request logging for Ingress-created load balancers by default** (Google's documentation: "By default, GKE enables access logging for all ingress types"). `gke.backendConfig.enabled: true` creates a BackendConfig with `logging.enable: false` and attaches it to the Service. Keep it on.
- GKE Ingress is selected by the `kubernetes.io/ingress.class: gce` annotation, not by `ingressClassName`.
- `gke.managedCertificate` creates a Google-managed certificate for the host; `gke.frontendConfig` redirects HTTP to HTTPS. Reserve the global static IP first and point DNS at it.
- Storage: `standard-rwo` (PD CSI). Never Filestore. Autopilot works with the chart's resources and security context **(not tested)**.
- NetworkPolicy needs Dataplane V2 or network policy enforcement; the example allows Google's front-end ranges.

## Upgrade

```sh
helm upgrade onetime deploy/helm/onetime -n onetime -f my-values.yaml --set image.digest=sha256:<new>
```

The StatefulSet deletes the old pod, waits until it is gone, then starts the new one on the same volume. Expect a few seconds of 502/503: in the kind test an upgrade showed 7 s of errors at the ingress, and a secret created before the upgrade could be revealed after it **(tested)**. Database migrations run at start.

`volumeClaimTemplates` cannot be changed on an existing StatefulSet (size, class). To move to a new volume, back up, uninstall, delete the PVC, reinstall and restore.

A node drain is an outage of the same kind. There is deliberately no PodDisruptionBudget (with one replica it would block drains forever). If a node dies, the pod stays on it until Kubernetes confirms the node is gone (or you force-delete the pod); that is what keeps a second writer from starting.

## Backup and restore

You may not need backups: a lost database only loses links nobody has opened yet. A backup keeps encrypted blobs of secrets that are later revealed, and **restoring it makes those links work again** until they expire. Keep backups short-lived, or do not take them.

Stop the pod first (the server holds a lock and recent changes can be in the WAL file), then use a helper pod with the same image on the same claim:

```sh
NS=onetime; IMG=registry.example.com/onetime@sha256:<digest>
HELPER='{"spec":{"securityContext":{"runAsUser":1000,"runAsGroup":1000,"fsGroup":1000},
  "volumes":[{"name":"d","persistentVolumeClaim":{"claimName":"data-onetime-0"}}],
  "containers":[{"name":"h","image":"'"$IMG"'","command":["sleep","600"],"volumeMounts":[{"name":"d","mountPath":"/data"}]}]}}'

kubectl -n $NS scale statefulset onetime --replicas=0
kubectl -n $NS wait --for=delete pod/onetime-0 --timeout=60s
kubectl -n $NS run helper --restart=Never --image="$IMG" --overrides="$HELPER"
kubectl -n $NS wait --for=condition=ready pod/helper --timeout=60s

# Backup (the archive is private to you):
(umask 077; kubectl -n $NS exec helper -- tar -czf - -C /data db > onetime-data.tgz)
# or restore:
#   kubectl -n $NS exec -i helper -- sh -c 'rm -rf /data/db && tar -xzf - -C /data' < onetime-data.tgz

kubectl -n $NS delete pod helper
kubectl -n $NS scale statefulset onetime --replicas=1
```

`kubectl scale` bypasses Helm; the chart always renders one replica, so the next `helm upgrade` keeps 1. In the kind test this exact sequence backed up and restored the volume, and a secret revealed after the backup could be revealed **again** after the restore (then 404 as usual) **(tested)**. Volume snapshots (CSI `VolumeSnapshot`, EBS/Azure/GCE snapshots) have the same restore effect **(not tested)**.

## Logging

Request paths contain secret ids. Checklist for every cluster:

1. The app: one start-up line, never request lines (`kubectl logs`).
2. The ingress controller: access log off, error log at a level that never writes request lines (ingress-nginx: `disable-access-log: "true"`, `error-log-level: crit`; Traefik: no `accessLog`).
3. The cloud load balancer: ALB access and connection logs off; Application Gateway access-log diagnostic category off; GKE BackendConfig `logging.enable: false`.
4. Anything else in the path (WAF, CDN, service mesh sidecars, API gateways) must not log paths either. A service mesh sidecar (Istio, Linkerd) logs requests by default in some setups: exclude the namespace or turn its access log off.

## Values reference

See `deploy/helm/onetime/values.yaml` (every key is commented) and `values.schema.json`. Notable keys: `ingress.maxBodyBytes` (proxy body limit, default 143360; at least 131490 for the largest file, see [deploy-architecture.md](deploy-architecture.md)), `config.maxStored` (ONETIME_MAX_STORED), `extraEnv` (map of further variables, for example `ONETIME_MAX_CONNECTIONS`; HOST, PORT and ONETIME_DB are refused), `persistence.*`, `ingress.*`, `networkPolicy.*`, `gke.*`, `extraObjects`.

## What was tested

Run on 2026-11-20 with Helm 3.17.0, kubeconform 0.8.0, kind 0.33.0 (Kubernetes 1.37.0, `rancher.io/local-path`), ingress-nginx controller 1.15.1 (kind manifest), Docker 26.1.4, the image built from this repository with `ONETIME_ORIGIN=https://onetime.test`.

| Check | Result |
|---|---|
| `helm lint --strict` with every example file and with minimal values | pass |
| `helm template` + `kubeconform -strict` (Kubernetes 1.31 schemas, CRD schemas from the datreeio catalog for BackendConfig, ManagedCertificate, FrontendConfig, Traefik Middleware) for every example | all valid |
| `replicaCount=2` | refused by the schema; with `--skip-schema-validation` refused by the template (also `0`) |
| `ReadWriteMany`, `extraEnv.HOST`, missing image, missing tag/digest, malformed digest | each refused |
| `trivy config` on rendered manifests | 0 high/critical; low/medium findings accepted (uid 1000 matches the image, no CPU limit on purpose, example registry name) |
| Install in kind with `values-kind-test.yaml` | pod ready, PVC bound, `helm test` passed |
| API round trip through ingress-nginx over HTTPS | create 200, status 200, GET reveal 405, POST reveal 200 with the same bytes, second reveal 404, 70 KB body 413 |
| Security headers through the ingress | CSP, HSTS (once), `no-store`, `X-Robots-Tag` as sent by the app |
| Pod | uid 1000, read-only root (write refused), CapEff 0, NoNewPrivs 1, seccomp 2, no service account token, `/data/db` 0700, database and WAL 0600, one start-up log line |
| NetworkPolicy | a pod in another namespace timed out; the ingress controller and the helm test pod got through |
| Second writer | a second pod mounting the same PVC exited with code 3 ("locked by another process") |
| Upgrade | old pod deleted before the new one was created; about 7 s of 502/503; data kept |
| Logging, controller defaults + annotation only | access log off for the Ingress, but the error log held a 413 line with client IP and, during a restart, `request: "POST /api/secrets/<id>/reveal"` |
| Logging, controller with `disable-access-log` and `error-log-level: crit` | 0 lines from the round trip, the 413 and a restart |
| Backup and restore with the helper pod above | archive holds `db/onetime.db`; after the restore a secret revealed after the backup was revealed again (200, then 404) |
| Terraform `examples/k8s-kubeconfig` against the same cluster | see [deploy-terraform.md](deploy-terraform.md) |

Not tested: AKS, EKS, GKE, k3s/Traefik, cert-manager issuance, Application Gateway for Containers, ALB, GKE BackendConfig behaviour, ManagedCertificate, `ReadWriteOncePod`, Autopilot, volume snapshots, arm64 nodes.
