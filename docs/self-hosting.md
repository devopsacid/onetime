# Self-hosting onetime

Run your own copy of onetime on a Linux host or VM: one Node process with a SQLite file, behind a TLS reverse proxy. The code is the same as on the public site. Draft: wording will be polished.

How to read this page: commands marked **(tested)** were run on Linux with Docker 26 and Node 22 during development (output recorded in `docs/plans/self-host.md`). Commands marked **(not tested)** were not run by the project.

> **Warning: one instance only.**
> The database is one SQLite file with one writer.
> - Do not run replicas, and do not scale the service above 1.
> - Do not put the database on a network filesystem (NFS, EFS, SMB, Azure Files). SQLite locking is not reliable there.
> - On a redeploy, stop the old container before you start the new one.
>
> The server takes an exclusive lock at start and refuses to start (exit code 3) when another process on the same local disk holds it. It cannot detect every network-share setup, so this rule stays yours to keep.

## Requirements

- Docker, or Node.js 22.13 or newer (24 recommended). Node 22 prints "ExperimentalWarning: SQLite is an experimental feature" at start. It is harmless; Node 24 does not print it.
- **HTTPS.** Browsers offer `crypto.subtle` (the encryption) only in a secure context. Over plain http the page works only on `localhost`. Use a reverse proxy with a certificate (see below).
- A domain name that points to the host (for a public certificate).

## Build settings

The public address is fixed when you build, so there is no ready-made image. Settings (build time):

| Variable | Needed | Meaning |
|---|---|---|
| `ONETIME_ORIGIN` | yes | The exact origin people type, e.g. `https://onetime.example`. No path, no trailing slash. `http` is accepted only as `http://localhost:<port>`. Links, canonical tags and the CLI default use it. |
| `ONETIME_OPERATOR_NAME` | no | Your name or organisation, shown on the privacy page. |
| `ONETIME_OPERATOR_CONTACT` | no | An email address or an https URL, shown on the privacy page. |
| `ONETIME_INDEXABLE` | no | `1` writes a `robots.txt` that allows crawling and a sitemap. Default: `Disallow: /`. |

If you offer the service to other people, set both operator variables. Without them the privacy page says "the operator of this instance" and names no one.

The self-host build contains no analytics and no Google code.

Run-time settings (environment of the server):

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` (Docker image: `0.0.0.0`) | Bind address. |
| `PORT` | `8080` | Port. |
| `ONETIME_DB` | `./data/onetime.db` (image: `/data/onetime.db`) | Database file. Its directory is created with mode 0700. |
| `ONETIME_MAX_STORED` | `20000` | Most unexpired secrets stored; create answers 503 when full. |

A wrong value stops the server with exit code 2.

## Docker

Build and run **(tested)**:

```sh
docker build --build-arg ONETIME_ORIGIN=https://onetime.example -t onetime .

docker run -d --name onetime --restart unless-stopped \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  -v onetime-data:/data -p 127.0.0.1:8080:8080 onetime
```

The container runs as uid 1000 (`node`), the database in the volume is mode 0600, and the health check calls `/healthz`. `docker stop onetime` shuts down cleanly in well under 10 seconds. `docker logs onetime` holds one start-up line and no request lines.

Do not publish port 8080 on all interfaces. The app speaks plain http; the proxy gives TLS and request limits.

A bind mount instead of a named volume must belong to uid 1000 (`chown 1000:1000 <dir>`) **(not tested)**.

## Docker Compose

`compose.yaml` builds the image and starts one service with the same settings (read-only root, no capabilities, `no-new-privileges`, restart policy, named volume, port on 127.0.0.1) **(tested)**:

```sh
ONETIME_ORIGIN=https://onetime.example docker compose up -d --build
```

Compose recreates the service by stopping the old container first **(not tested)**. Never raise `scale`.

## systemd, without Docker

The unit `deploy/onetime.service` expects this layout:

```
/opt/onetime/dist-server/server.mjs
/opt/onetime/dist-selfhost/
/opt/onetime/migrations/
```

Build on any machine, then copy the three folders **(build and run from a copy of this layout: tested; copying to `/opt` and `systemctl`: not tested)**:

```sh
pnpm install --frozen-lockfile
ONETIME_ORIGIN=https://onetime.example pnpm build:selfhost
sudo mkdir -p /opt/onetime
sudo cp -r dist-server dist-selfhost migrations /opt/onetime/
sudo cp deploy/onetime.service /etc/systemd/system/onetime.service
sudo systemctl daemon-reload
sudo systemctl enable --now onetime
```

The unit runs as a dynamic user, keeps the database in `/var/lib/onetime`, listens on `127.0.0.1:8080`, and has strict sandbox settings. `systemd-analyze verify deploy/onetime.service` passes and `systemd-analyze security` rates it 1.3 OK **(tested)**. The unit was not started under systemd by the project. It needs `node` at `/usr/bin/node`; edit `ExecStart` otherwise.

The sandbox does not set `MemoryDenyWriteExecute`, because V8 needs it.

## Reverse proxy

The proxy must: terminate TLS, forward to `127.0.0.1:8080`, **keep no access log** (request paths contain secret ids), and limit request bodies to about 64 KB.

- `deploy/Caddyfile.example`: Caddy gets the certificate itself. It has no `log` directive; do not add one. Tested with `tls internal` (Caddy's local CA) in a container: page, security headers, the full create / reveal round trip, 413 on a 70 KB body, and no request line in the container log **(tested)**.
- `deploy/nginx.conf.example`: `access_log off`, `error_log ... crit`, `client_max_body_size 64k`, no forwarding headers. Tested with a self-signed certificate in a container: same checks **(tested)**. One catch: other server blocks, such as the distribution's default site, keep their own access log and catch requests with an unknown host name. Remove them. In the test, the image's `default.conf` logged one request line with a client IP until it was removed.
- Certificates (certbot, acme.sh) **(not tested)**.

The app never reads `Host` or `X-Forwarded-*` headers.

### Optional rate limiting

The app has no per-IP limit, because it keeps no IPs. Only the 20,000-secret cap protects it from being filled. If you add rate limiting in the proxy, the proxy keeps client IPs in memory for it (nginx `limit_req`, Caddy rate-limit plugin) **(not tested)**. That is a trade-off against "no IPs are kept"; say so on your privacy page if you do it.

### HSTS

`public/_headers` sends `Strict-Transport-Security: max-age=31536000; includeSubDomains`. If you serve onetime from an apex domain and other subdomains still use plain http, edit that line before you build.

## Cloud VMs

A VM with a local block disk works the same way as any Linux host. Follow the Docker or systemd steps above.

- **AWS EC2 or a Lightsail instance** (a VM, not the Lightsail container service): use the instance disk or EBS. **Not tested by the project.**
- **Azure VM** with a managed disk. **Not tested by the project.**

Open only ports 80 and 443 to the world; keep 8080 closed.

## Managed container platforms: not supported yet

Lightsail container service, ECS Fargate, Azure Container Apps and App Service are not supported:

- SQLite documents that WAL mode does not work over a network filesystem. ECS Fargate persists data only on EFS (NFS), and Azure Container Apps only on Azure Files (SMB or NFS).
- App Service keeps serving from the old container while the new one starts, so two writers can overlap on shared storage.
- The Lightsail container service documents no persistent volumes, so a redeploy would empty the database.

They need a different store (Postgres). That is not built.

## Backups

You do not need backups: a lost database only loses links that were not opened yet. But a backup keeps encrypted blobs for as long as you keep the backup, including secrets already revealed or expired, so a backup extends how long encrypted data exists. The key is never in it. Keep backups short-lived and protected, or skip them, and say so on your privacy page.

If you do back up, stop the server first. It holds an exclusive lock, so the file is not safe to copy while it runs. Docker volume **(tested)**:

```sh
docker stop onetime
docker run --rm -v onetime-data:/data:ro -v "$PWD":/backup node:24-alpine tar -czf /backup/onetime-data.tgz -C /data .
docker start onetime
```

Also remember that the SQLite file keeps deleted data only until pages are reused; `secure_delete` zeroes deleted blobs in the main file.

## Command-line client

The CLI works with any instance:

```sh
onetime send --server https://onetime.example
ONETIME_SERVER=https://onetime.example onetime get
```

Or download it from your own instance. That copy already defaults to your origin **(tested, with `http://localhost`)**:

```sh
curl -fsSL https://onetime.example/cli/onetime.mjs -o onetime && chmod +x onetime
curl -fsSL https://onetime.example/cli/onetime.mjs.sha256 -o onetime.mjs.sha256
```

Links from any instance open with any CLI build, because `get` uses the origin of the link. The CLI needs Node 20 or newer; the server needs 22.13.

## Operating notes

- Health check: `GET /healthz` returns 200 `ok`.
- Expired secrets are never handed out. Their rows are removed on later API requests, not by a timer, so an idle instance keeps them until the next request.
- Updating: pull the new source, build again with the same `ONETIME_ORIGIN`, stop the old process, start the new one on the same data.
- Do not keep Docker or journal logs of request lines: the app writes none. Check that your proxy does not.
