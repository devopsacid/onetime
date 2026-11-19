# Self-hosting onetime

Run your own copy of onetime on a Linux host or VM. It is one Node process with one SQLite file, behind a reverse proxy that provides HTTPS. The code is the same as on the public site.

Marks used on this page:

- **(tested)**: the project ran this command or setup on Linux (Docker 26, Node 22 on the host, Node 24 in the image). See [What was tested](#what-was-tested).
- **(not tested)**: the project did not run it. It should work, but check it yourself.

> **Warning: run one instance only.**
>
> The database is one SQLite file, and only one process may write to it.
>
> - Do not run replicas, and never scale the service above 1.
> - Do not put the database on a network filesystem (NFS, EFS, SMB, Azure Files). SQLite locking is not reliable there.
> - When you update, stop the old container or process before you start the new one.
>
> The server locks the database at start. A second server on the same local disk refuses to start (exit code 3). The server cannot detect every network-share setup, so keeping this rule is up to you.

## Contents

1. [Before you start](#before-you-start)
2. [Quick start with Docker Compose](#quick-start-with-docker-compose)
3. [Docker without Compose](#docker-without-compose)
4. [systemd, without Docker](#systemd-without-docker)
5. [Reverse proxy and HTTPS](#reverse-proxy-and-https)
6. [Cloud VMs](#cloud-vms)
7. [Backups](#backups)
8. [Updating](#updating)
9. [Command-line client](#command-line-client)
10. [Settings reference](#settings-reference)
11. [Troubleshooting](#troubleshooting)
12. [What was tested](#what-was-tested)

## Before you start

You need:

- **Docker** (with Compose for the quick start), **or Node.js 22.13 or newer** for running without Docker. Node 24 is recommended. The Docker image uses Node 24.
  - On Node 22 the server prints `ExperimentalWarning: SQLite is an experimental feature` at start. It is harmless. Node 24 does not print it.
- **HTTPS.** Browsers only allow the page's encryption (`crypto.subtle`) in a secure context. Over plain http the page works only on `localhost`. For any other address, put a reverse proxy with a certificate in front.
- **A domain name** that points to your host, so the proxy can get a public certificate.

The public address (origin) is fixed when you build. That is why there is no ready-made image: you always build your own. Set it with `ONETIME_ORIGIN`, for example `https://onetime.example`. Use the exact origin people will type: no path, no trailing slash.

If you offer the service to other people, also set `ONETIME_OPERATOR_NAME` and `ONETIME_OPERATOR_CONTACT`, so the privacy page names you. All build settings are in [Settings reference](#settings-reference).

The self-host build contains no analytics and no Google code.

## Quick start with Docker Compose

`compose.yaml` builds the image and starts one service with a read-only root filesystem, no Linux capabilities, `no-new-privileges`, a restart policy, a named volume for the database, and the port bound to `127.0.0.1` only.

**1. Try it on your own machine.** Plain http is fine on `localhost` **(tested)**:

```sh
ONETIME_ORIGIN=http://localhost:8080 docker compose up -d --build
```

Open http://localhost:8080, create a secret and open the link.

**2. Run it for real.** Build with your public https origin **(tested)**:

```sh
ONETIME_ORIGIN=https://onetime.example docker compose up -d --build
```

Then set up the [reverse proxy](#reverse-proxy-and-https). Until the proxy runs, the site is not reachable from outside, which is intended.

Notes:

- Without `ONETIME_ORIGIN`, Compose refuses to build and prints why **(tested)**.
- Never raise `scale`.
- When Compose recreates the service, it stops the old container before it starts the new one **(not tested)**.
- Compose adds a project prefix to names: the container is called something like `onetime-onetime-1` and the volume `onetime_onetime-data` (the prefix is the folder name by default). `docker compose ps` and `docker volume ls` show the real names. The Compose backup command below looks the volume name up itself.

## Docker without Compose

Build and run **(tested)**:

```sh
docker build --build-arg ONETIME_ORIGIN=https://onetime.example -t onetime .

docker run -d --name onetime --restart unless-stopped \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  -v onetime-data:/data -p 127.0.0.1:8080:8080 onetime
```

What you get:

- The container runs as uid 1000 (user `node`). The database file in the volume has mode 0600.
- The health check calls `/healthz`. The container shows as healthy after the first 30-second check.
- `docker stop onetime` shuts down cleanly (about half a second in the test).
- `docker logs onetime` holds one start-up line and no request lines.

Keep `-p 127.0.0.1:8080:8080`. Do not publish port 8080 on all interfaces: the app speaks plain http, and the proxy provides TLS and request limits.

A bind mount (a host folder) instead of the named volume must belong to uid 1000: `chown 1000:1000 <dir>` **(not tested)**.

## systemd, without Docker

Use this if you run Node directly on the host. The unit `deploy/onetime.service` expects this layout:

```
/opt/onetime/dist-server/server.mjs
/opt/onetime/dist-selfhost/
/opt/onetime/migrations/
```

Build on a Linux machine with Node 22.13+ and glibc (Debian, Ubuntu, Fedora and similar), then copy the three folders and install the unit. `pnpm install` fetches the `workerd` binary used by the test tooling, and that binary needs glibc. On an Alpine (musl) host, build with Docker instead (see [Docker without Compose](#docker-without-compose)), or build on a glibc machine and copy the three folders: running the server needs only Node **(not tested on an Alpine host)**.

```sh
pnpm install --frozen-lockfile
ONETIME_ORIGIN=https://onetime.example pnpm build:selfhost
sudo mkdir -p /opt/onetime
sudo cp -r dist-server dist-selfhost migrations /opt/onetime/
sudo chmod -R a+rX /opt/onetime
sudo cp deploy/onetime.service /etc/systemd/system/onetime.service
sudo systemctl daemon-reload
sudo systemctl enable --now onetime
```

What was tested here: the build, and running `node dist-server/server.mjs` from a copy of this layout **(tested)**. Copying to `/opt`, `systemctl` and starting the unit under systemd **(not tested)**. Getting pnpm on a bare host (the project pins the version in `package.json`; `corepack enable` provides it) **(not tested)**; it was only run inside the Docker build.

The `chmod` is needed because the unit runs as a dynamic user that owns nothing in `/opt/onetime`. If your build ran with a strict umask (`077`), the copied files are readable by their owner only, and the service could not read its own code. `chmod -R a+rX` makes files readable and keeps execute bits only where they already were. Run on a copy made under `umask 077`: before the command, folders and files are `drwx------` and `-rw-------`; after it `drwxr-xr-x` and `-rw-r--r--` **(tested in a temporary folder; with a real dynamic user not tested)**.

About the unit:

- It runs as a dynamic user, keeps the database in `/var/lib/onetime`, and listens on `127.0.0.1:8080`.
- It expects `node` at `/usr/bin/node`. If yours is elsewhere, edit `ExecStart`.
- It does not restart on exit code 2 (bad settings) or 3 (database locked), so a broken setup does not loop.
- It has strict sandbox settings. `systemd-analyze verify` passes and `systemd-analyze security` rates it 1.3 OK **(tested)**. It does not set `MemoryDenyWriteExecute`, because Node's JIT compiler needs writable and executable memory.

## Reverse proxy and HTTPS

The proxy must:

- terminate TLS (HTTPS) and forward to `127.0.0.1:8080`;
- **keep no access log**, because request paths contain secret ids;
- limit request bodies to about 64 KB (a secret is at most 16 KB).

The app never reads `Host` or `X-Forwarded-*` headers, so the proxy needs no forwarding setup.

### Caddy

Use `deploy/Caddyfile.example`. Replace the host name.

- Caddy gets and renews the certificate itself when the domain points to the host and ports 80 and 443 are open. With a public CA certificate **(not tested)**.
- The example has no `log` directive. Do not add one: Caddy writes access logs only when `log` is present.
- Tested with Caddy's local CA (`tls internal`) in a container: page, security headers, the full create and reveal round trip, a 70 KB body refused with 413, and no request line in Caddy's log **(tested)**.

### nginx

Use `deploy/nginx.conf.example` as `/etc/nginx/conf.d/onetime.conf`. Replace the host name and certificate paths.

- It sets `access_log off`, `error_log ... crit` (lower levels write the request line, with the id), `client_max_body_size 64k`, and sends no forwarding headers.
- Also set the global `error_log` in `nginx.conf` to `crit`.
- **Remove the default site.** Other server blocks, such as the distribution's default site or the nginx image's `conf.d/default.conf`, keep their own access log and catch requests with an unknown host name. In the project's test, `default.conf` logged one request line with a client IP until it was removed.
- Tested with a self-signed certificate in a container: same checks as Caddy **(tested)**.
- Getting the certificate with certbot or acme.sh **(not tested)**.

### HSTS

The site sends `Strict-Transport-Security: max-age=31536000; includeSubDomains` (set in `public/_headers`). `includeSubDomains` makes browsers use HTTPS for every subdomain of the host that serves onetime. If you serve onetime from an apex domain (for example `example.com`) and some subdomains still use plain http, edit that line before you build.

### Optional rate limiting

The app has no per-IP limit, because it keeps no IPs. Only the cap on stored secrets (20,000 by default) stops someone from filling it; when full, creating a secret answers 503.

You can add rate limiting in the proxy (nginx `limit_req`, or a Caddy rate-limit plugin; both examples contain commented hints) **(not tested)**. The proxy then keeps client IPs in memory. That is a trade-off against "no IPs are kept", so say so on your privacy page if you do it.

## Cloud VMs

A cloud VM with a local block disk works like any Linux host. Follow the Docker or systemd steps above.

- **AWS EC2 or a Lightsail instance** (a VM, not the Lightsail container service): keep the data on the instance disk or EBS. **Not tested by the project.**
- **Azure VM** with a managed disk. **Not tested by the project.**

In the firewall or security group, open only ports 80 and 443 to the world. Keep 8080 closed.

ARM (arm64) VMs: the base images support arm64, but the project built and ran only on amd64 **(not tested)**.

### Managed container platforms: not supported yet

Lightsail container service, ECS Fargate, Azure Container Apps and Azure App Service are not supported, because none of them gives this SQLite setup a safe local disk:

- SQLite documents that its WAL mode does not work over a network filesystem. ECS Fargate keeps data only on EFS (NFS), and Azure Container Apps only on Azure Files (SMB or NFS).
- App Service keeps serving from the old container while the new one starts, so two writers can overlap on shared storage.
- The Lightsail container service documents no persistent volumes, so every redeploy would empty the database.

These platforms need a different database (such as Postgres). That is not built.

## Backups

You do not need backups. A lost database only loses links that nobody has opened yet.

A backup has a cost: it keeps encrypted blobs for as long as you keep the backup, including secrets already revealed or expired. The keys and the plaintext are never in the database, so a backup cannot be read without the links. But it does extend how long encrypted data exists. Keep backups short-lived and protected, or skip them, and say on your privacy page what you do.

If you back up, **stop the server first.** While it runs it holds the database locked and recent changes can sit in the WAL file next to it, so copying the files is not safe.

Plain Docker volume **(tested)**:

```sh
docker stop onetime
docker run --rm -v onetime-data:/data:ro -v "$PWD":/backup node:24-alpine \
  sh -c 'umask 077 && tar -czf /backup/onetime-data.tgz -C /data . && chown "$0:$1" /backup/onetime-data.tgz' "$(id -u)" "$(id -g)"
docker start onetime
```

Compose. Compose prefixes the volume name with the project name (`<project>_onetime-data`), so ask Docker for the real name instead of guessing it **(tested with a test project)**:

```sh
docker compose stop
VOLUME=$(docker inspect -f '{{range .Mounts}}{{.Name}}{{end}}' "$(docker compose ps -aq onetime)")
docker run --rm -v "$VOLUME":/data:ro -v "$PWD":/backup node:24-alpine \
  sh -c 'umask 077 && tar -czf /backup/onetime-data.tgz -C /data . && chown "$0:$1" /backup/onetime-data.tgz' "$(id -u)" "$(id -g)"
docker compose start
```

The archive `onetime-data.tgz` in the current folder holds the database, and it belongs to you with mode 0600. Without the `umask` and `chown` the helper container (which runs as root) would write a root-owned archive that anyone can read. `docker run --user "$(id -u):$(id -g)"` does not work as a replacement: the data folder belongs to uid 1000 and has mode 0700, so any other user gets "Permission denied" and an empty archive **(tested)**. Restoring a backup **(not tested)**.

## Updating

1. Get the new source.
2. Build again with the same `ONETIME_ORIGIN` (and operator settings).
3. Stop the old container or process.
4. Start the new one on the same data (the same volume, or `/var/lib/onetime`).

Database changes are applied automatically at start.

With Compose, the same `docker compose up -d --build` command as in the quick start does steps 2 to 4. With plain Docker, stop and remove the old container (`docker stop onetime`, `docker rm onetime`), then run the build and run commands again. This update order **(not tested)** as a whole; the single commands are the ones from the sections above.

With systemd, do not copy over the old folders: `cp -r` merges, so assets of the old build (`dist-selfhost/assets/main-<old hash>.js`) stay behind. Replace the folders instead, from the folder with the new build:

```sh
sudo systemctl stop onetime
sudo rm -rf /opt/onetime/dist-server /opt/onetime/dist-selfhost /opt/onetime/migrations
sudo cp -r dist-server dist-selfhost migrations /opt/onetime/
sudo chmod -R a+rX /opt/onetime
sudo systemctl start onetime
```

The database is not in `/opt/onetime` (it is in `/var/lib/onetime`), so it stays. Run in a temporary folder with an old install containing a stale asset: after the `rm` and `cp` only the new files were there **(tested in a temporary folder; the `systemctl` lines not tested)**.

## Command-line client

The `onetime` CLI works with any instance. Point it at yours with `--server` or `ONETIME_SERVER`:

```sh
onetime send --server https://onetime.example
ONETIME_SERVER=https://onetime.example onetime get
```

Or download the CLI from your own instance. That copy already uses your origin by default **(tested, with an http://localhost instance)**:

```sh
curl -fsSL https://onetime.example/cli/onetime.mjs -o onetime && chmod +x onetime
curl -fsSL https://onetime.example/cli/onetime.mjs.sha256 -o onetime.mjs.sha256
```

The README explains how to check the download with `sha256sum`.

Links from any instance open with any CLI copy, because `get` uses the origin in the link. The CLI needs Node 20 or newer; the server needs Node 22.13 or newer.

## Settings reference

### Build settings

Set these when you build (Docker build args, Compose environment, or the environment of `pnpm build:selfhost`).

| Variable | Needed | Meaning |
|---|---|---|
| `ONETIME_ORIGIN` | yes | The exact origin people type, e.g. `https://onetime.example`. No path, no trailing slash. `http` is accepted only as `http://localhost:<port>`. Links, canonical tags and the CLI default use it. |
| `ONETIME_OPERATOR_NAME` | no | Your name or organisation, shown on the privacy page. |
| `ONETIME_OPERATOR_CONTACT` | no | An email address or an https URL, shown on the privacy page. |
| `ONETIME_INDEXABLE` | no | `1` writes a `robots.txt` that allows crawling, plus a sitemap. Default: `robots.txt` with `Disallow: /`, no sitemap, and `X-Robots-Tag: noindex` on every response the static site sends. |

Without the operator settings, the privacy page says "the operator of this instance" and names no one.

### Run-time settings

Set these in the server's environment.

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` (Docker image: `0.0.0.0`) | Address to listen on. |
| `PORT` | `8080` | Port. |
| `ONETIME_DIST` | `dist-selfhost` next to `dist-server/` (image: `/app/dist-selfhost`, systemd layout: `/opt/onetime/dist-selfhost`) | Folder with the built site (`pnpm build:selfhost`). The server refuses to start if it has no `_selfhost.json`, for example the Pages `dist/`. Relative paths are resolved against the working directory. |
| `ONETIME_DB` | `./data/onetime.db` (image: `/data/onetime.db`, systemd unit: `/var/lib/onetime/onetime.db`) | Database file. Its folder is created with mode 0700. |
| `ONETIME_MAX_STORED` | `20000` | Most unexpired secrets stored at once. Creating a secret answers 503 when full. |

## Troubleshooting

### By exit code

The server writes the reason to stderr (`docker logs`, or `journalctl -u onetime`).

| Exit code | Meaning | What to do |
|---|---|---|
| 0 | Clean stop after SIGTERM or SIGINT. | Nothing. |
| 1 | Any other start-up error, printed as `onetime: could not start (<code>)`. A second stop signal while shutting down also exits 1. | Read the code in brackets, for example a permission problem on the database folder. |
| 2 | Bad settings, a missing or wrong site folder, or Node older than 22.13. | Fix the value named in the message. "has no _selfhost.json" means the folder is not a self-host build: build with `pnpm build:selfhost`, not `pnpm build`. |
| 3 | The database is locked by another process: "Only one onetime server may use it." | Another server uses the same database. Stop it. See the warning at the top. |

### Other problems

- **The page loads, but creating or opening a secret fails.** The page is served over plain http on an address other than `localhost`. Browsers block the encryption there. Use HTTPS.
- **Links point to the wrong address.** `ONETIME_ORIGIN` was wrong at build time. Build again with the right origin.
- **Container shows "starting" for a while.** The first health check runs after 30 seconds.
- **Health check by hand:** `GET /healthz` answers 200 `ok`.
- **Expired secrets are still in the database.** Expected. Expired secrets are never handed out, but their rows are removed on later API requests, not by a timer. An idle instance keeps them until the next request.
- **Deleted data on disk.** Deleted blobs are zeroed in the main database file (`secure_delete`). The WAL file next to it can still hold copies of recent encrypted blobs until SQLite folds it back into the main file; a clean stop empties it.
- **Warning at start: "folder ... has mode 755" or "onetime.db has mode 644".** The data folder or the database files can be reached by other users on the host. The server prints one line to stderr and keeps running; it never changes modes itself. It happens with a folder you made yourself or a bind mount, because only a folder the server creates gets mode 0700. Fix it with `chmod 700 <folder>` and `chmod 600 <folder>/onetime.db*` (stop the server first). The blobs are encrypted and the keys are never stored, but the files are meant to be private. The check is skipped on Windows.
- **Logs.** The app writes no request lines. Check that your proxy does not either, and that no Docker or journal setting adds them.

## What was tested

The project ran these checks on 2026-11-19 on Linux with Docker 26.1.4, Node 22.22.1 on the host and Node 24 in the image:

- **Docker image:** builds with `ONETIME_ORIGIN` (refuses without it). Image size 172 MB. Runs with a read-only root, no capabilities and `no-new-privileges`: healthy, uid 1000, data folder 0700, database and WAL files 0600, no `-shm` file, one start-up line in the log.
- **API round trip** with curl against the container: create, check, reveal once, second reveal refused. Security headers and caching headers as on the public site.
- **Stop and lock:** `docker stop` took about half a second, exit code 0. A second container on the same volume refused to start with exit code 3.
- **Compose:** starts with `ONETIME_ORIGIN=http://localhost:8080`, health check 200, read-only root, capabilities dropped, `no-new-privileges`, restart policy set, `robots.txt` with `Disallow: /`. Refuses without `ONETIME_ORIGIN`.
- **Caddy** (local CA) and **nginx** (self-signed certificate) in containers in front of the app: HTTPS reaches the app, full round trip, 413 on a 70 KB body, no access-log lines and no secret ids in the proxy logs (nginx only after removing the image's default site).
- **systemd unit:** `systemd-analyze verify` passes; `systemd-analyze security` rates it 1.3 OK. The unit was not started.
- **Without Docker:** the three folders copied to a temporary location and started with `node dist-server/server.mjs`: health check 200, data folder 0700, database 0600, ExperimentalWarning on Node 22. The operator settings appear on the privacy page.
- **CLI** downloaded from the container: checksum OK, `send` and `get` work with `--server` and `ONETIME_SERVER`, a second `get` reports the secret as already opened, and without a server option it uses the built-in origin.
- **Backup:** `tar` of the volume after `docker stop` holds the database; the final command with `umask` and `chown` was run on a plain named volume (archive owned by the host user, mode 0600). With a Compose test project, the volume name found with `docker inspect` is the prefixed one, the archive made with `umask 077` and an in-container `chown` belongs to the host user with mode 0600, and `--user` with a host uid other than 1000 fails with "Permission denied". The test project, its volume and its image were removed afterwards.
- **systemd layout, in a temporary folder:** replacing the three folders removes stale assets of the old build; `chmod -R a+rX` turns `drwx------`/`-rw-------` copies into `drwxr-xr-x`/`-rw-r--r--`.
- **Start-up warning:** a world-readable data folder makes the server print one line to stderr and keep running; a folder it creates itself prints nothing.

Not tested by the project: starting the systemd unit, `chown` for bind mounts, certbot and acme.sh, a public CA certificate with Caddy, proxy rate limiting, the Compose recreate order, pnpm via corepack on a bare host, restoring a backup, arm64 images, AWS EC2 and Lightsail instances, Azure VMs, and macOS or Windows hosts.
