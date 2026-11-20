# Deploying onetime with Ansible (plain Linux host)

The role is `deploy/ansible/roles/onetime`, with an example playbook (`deploy/ansible/playbook.yml`) and inventory (`deploy/ansible/inventory.example.yml`). Read [deploy-architecture.md](deploy-architecture.md) and [self-hosting.md](self-hosting.md) first.

Marks: **(tested)** = the project ran it (see [What was tested](#what-was-tested)); **(not tested)** = it did not.

## What it does

One host, one instance, two modes:

| | Docker mode (default) | systemd mode |
|---|---|---|
| Runs | your image, by `docker run` inside a systemd unit `onetime.service` | `node dist-server/server.mjs` with `deploy/onetime.service` (copied unchanged) plus a drop-in |
| Hardening | as `compose.yaml`: read-only root, `--cap-drop ALL`, `no-new-privileges`, port on `127.0.0.1`, `local` log driver capped at 1 MB | the unit's sandbox (DynamicUser, ProtectSystem=strict, empty capability set, syscall filter, ...) |
| User | host system user `onetime` (not uid 1000, which is often the cloud image's login user) | systemd dynamic user |
| Database | `/var/lib/onetime` (mode 0700), bind-mounted at `/data` | `/var/lib/onetime` (the unit's StateDirectory, really `/var/lib/private/onetime`) |
| Gets the code | `docker pull` (optional registry login) or a `docker save` archive copied from the controller | a `.tar.gz` of `dist-server/`, `dist-selfhost/`, `migrations/` from the controller, unpacked into `/opt/onetime/releases/<checksum>/`, `/opt/onetime/current` points to it |
| Installs | Docker (`docker.io` on Debian/Ubuntu, Docker CE on the RHEL family) | Node 24 from NodeSource (or the distribution's nodejs), checks it is 22.13 or newer |

Both modes use `Restart=on-failure` with `RestartPreventExitStatus=2 3`, so a bad configuration or a locked database does not restart in a loop.

Optional reverse proxy (`onetime_proxy`):

- **Caddy** (default): automatic HTTPS, `request_body max_size` derived from `onetime_max_file_bytes` (or `onetime_max_body_bytes`), no read or upstream timeout (Caddy has none by default), no `log` directive, **and** a global `log default { exclude http.log.error http.stdlib }`. That last part is needed: without it Caddy still writes handler errors with the full request URI and the client IP. The project's test put `POST /api/secrets/<id>/reveal` into the journal by sending a reveal while the app was stopped (as during every restart). `deploy/Caddyfile.example` has the same block.
- **nginx**: `access_log off` in `nginx.conf` and in the site, the global `error_log` set to `crit`, the Debian/Ubuntu default site removed, `client_max_body_size`, `proxy_read_timeout` and `proxy_send_timeout` derived from `onetime_max_file_bytes` (or the overrides), `client_body_timeout 30s`, no forwarding headers. The role does **not** touch existing log files or other sites: log files written before it ran stay on disk (delete them yourself if they may hold request paths), and any other `server` block with its own `access_log` keeps logging its own requests. You provide the certificate (certbot, acme.sh, your CA); `onetime_nginx_selfsigned: true` creates a self-signed one for tests. Uses `http2 on` on nginx 1.25.1+ and `listen ... http2` on older versions. On SELinux hosts it sets `httpd_can_network_connect`.
- **none**: bring your own proxy; it must follow the logging rule.

The role does not manage the firewall: open 80 and 443, keep 8080 closed.

## Prerequisites

- Controller: Ansible core 2.16 or newer. No collections are needed (only `ansible.builtin`).
- Target: Debian 12/13, Ubuntu 24.04, or RHEL/Rocky/Alma 9/10, with Python 3, SSH and sudo.
- Package sources: the NodeSource and Docker CE repository keys are downloaded over HTTPS from their vendors and are **not** pinned to a fingerprint. If you need that, put the keys in place yourself (or mirror the repositories) and set `onetime_node_install: none` / `onetime_docker_install: false`.
- A registry login (`onetime_registry`) is used only for the pull and logged out again right after it, also when the pull fails. Caddy on the RHEL family comes from EPEL (the role installs `epel-release`; on RHEL proper enable EPEL yourself).
- `--check` on Debian/Ubuntu needs `python3-apt` on the target (Ansible's apt module cannot install it in check mode). Debian and Ubuntu cloud images have it.
- DNS for `onetime_domain` pointing at the host, so Caddy can get a certificate.

## Build what you deploy

Docker mode, build and push (or save) your image:

```sh
docker build --build-arg ONETIME_ORIGIN=https://onetime.example.com -t registry.example.com/onetime:2026-11-20 .
docker push registry.example.com/onetime:2026-11-20      # then use the digest, or:
docker save registry.example.com/onetime:2026-11-20 -o onetime-image.tar   # onetime_image_archive, no registry needed
```

systemd mode, build the bundle on a glibc Linux machine with Node 22.13+:

```sh
pnpm install --frozen-lockfile
ONETIME_ORIGIN=https://onetime.example.com pnpm build:selfhost
tar -czf onetime-bundle.tgz dist-server dist-selfhost migrations
```

The role refuses a bundle without `dist-selfhost/_selfhost.json` (a Pages build).

## Usage

```sh
cd deploy/ansible
cp inventory.example.yml inventory.yml   # edit host, domain, image or bundle
ansible-playbook -i inventory.yml playbook.yml --check --diff   # dry run
ansible-playbook -i inventory.yml playbook.yml
```

The playbook refuses to run on more than one host at once unless you set `onetime_allow_multiple_independent_instances: true`: each host would be its own instance with its own database and links. The role ends with a `/healthz` check.

Main variables (all in `roles/onetime/defaults/main.yml`, validated by `meta/argument_specs.yml`):

| Variable | Default | Meaning |
|---|---|---|
| `onetime_mode` | `docker` | `docker` or `systemd` |
| `onetime_image` | | Docker mode, required: your image, preferably `...@sha256:...` |
| `onetime_image_archive` | | Docker mode: `docker save` archive on the controller, loaded instead of pulled |
| `onetime_image_pull` | `missing` | `always` re-pulls a moving tag on every run |
| `onetime_registry`, `_username`, `_password` | | optional login before the pull (`no_log`); keep the password in Ansible Vault |
| `onetime_bundle_archive` | | systemd mode, required: the bundle `.tar.gz` |
| `onetime_node_install` | `nodesource` | `nodesource`, `distro` or `none` |
| `onetime_proxy` | `caddy` | `caddy`, `nginx` or `none` |
| `onetime_domain` | | the host of `ONETIME_ORIGIN`; required with a proxy |
| `onetime_max_stored` | | ONETIME_MAX_STORED |
| `onetime_max_file_bytes` | `262144` | ONETIME_MAX_FILE_BYTES, largest file in bytes (0 to 5242880, 0 = files off); the proxy body limit and timeouts follow from it. Above 1 MiB, consider `ONETIME_MAX_UPLOADS` in `onetime_env` (each upload is held about three times in memory) |
| `onetime_max_file_ttl` | `3600` | ONETIME_MAX_FILE_TTL, longest life of a file in seconds (60 to 604800) |
| `onetime_env` | `{}` | more variables, e.g. `ONETIME_MAX_CONNECTIONS: "200"` or `ONETIME_MAX_UPLOADS: "4"`; HOST, PORT, ONETIME_DB, ONETIME_MAX_FILE_BYTES and ONETIME_MAX_FILE_TTL are refused |
| `onetime_data_dir` | `/var/lib/onetime` | Docker mode database folder (mount a data disk here) |
| `onetime_require_data_mount` | `false` | `true` when a separate data disk is used: the unit refuses to start unless the database folder is a mount point |
| `onetime_max_body_bytes` | empty | proxy body limit override in bytes; empty = the largest blob plus 3 %, rounded up to 100 KiB (307200 by default, 1126400 at 1 MiB, 5427200 at 5 MiB, 102400 with files off). A number below the largest blob fails the assert |
| `onetime_proxy_timeout` | empty | nginx `proxy_read_timeout`/`proxy_send_timeout` override in seconds; empty = the app's upload timeout plus 10 s, rounded up to 10 s (80 by default, 110 at 1 MiB, 230 at 5 MiB) |

With a separate data disk: in Docker mode mount it at `/var/lib/onetime` before the first run (the Terraform VM modules do that). In systemd mode the unit's state lives in `/var/lib/private/onetime`; mount the disk there **(not tested)**. Set `onetime_require_data_mount: true` in both cases, so the app never starts on the root disk when the data disk is missing (`ExecStartPre=mountpoint -q ...`; **not tested** in the role, the same guard is tested in the Terraform bootstrap). Local or block storage only, never NFS/SMB.

Switching modes on one host (Docker to systemd or back) does not move the database: Docker mode keeps it in `/var/lib/onetime` (owner `onetime`), systemd mode in `/var/lib/private/onetime` (owned by the dynamic user, which systemd fixes on start). Stop the service, move the files yourself (`onetime.db`, and `onetime.db-wal` if present), then run the playbook with the new mode.

## Upgrade

Run the playbook again with the new image digest, archive or bundle. The unit restarts: the old process stops before the new one starts, so there is a short outage by design. In systemd mode the new release gets its own folder, `current` switches, and the old release folder is removed after the new one answers `/healthz`, so assets of an old build never stay behind **(tested)**.

## Backup and restore

You may not need backups: a lost database only loses links nobody has opened yet. A backup keeps encrypted blobs of secrets that are later revealed, and **restoring it makes those links work again** until they expire (shown in the Kubernetes test, [deploy-helm.md](deploy-helm.md)). Keep backups short-lived, or do not take them.

```sh
sudo systemctl stop onetime
sudo tar -czf /root/onetime-data.tgz -C /var/lib onetime          # systemd mode: -C /var/lib/private onetime
sudo systemctl start onetime
```

Restore: stop, replace the folder's contents with the archive (keep owner and mode 0700/0600), start. Backup and restore on a host **(not tested)**.

## Logging

- The app: one start-up line (`journalctl -u onetime`, in Docker mode also `docker logs onetime`), never request lines.
- Caddy: no `log` directive, handler errors and TLS handshake errors excluded globally.
- nginx: access logs off everywhere, error log at `crit`, default site removed.
- journald keeps whatever the services write; nothing here writes request paths.

## What was tested

Run on 2026-11-20 against throwaway privileged containers with systemd as PID 1 (not real hosts), controller Ansible core 2.20.1, the image and bundle built from this repository with `ONETIME_ORIGIN=https://onetime.test`. `ansible-lint` 26.11.0 (production profile) and `ansible-playbook --syntax-check`: pass.

| Target | Mode / proxy | Result |
|---|---|---|
| Debian 13 | Docker (image from a `docker save` archive) + Caddy (`tls internal`) | `--check` on the fresh host passed (with expected ignored "service not found" errors); first run ok; second run `changed=0`; `--check` after it `changed=0`. Container: read-only root, `CapDrop [ALL]`, `no-new-privileges`, user `onetime` (996), port `127.0.0.1:8080`, `local` log driver; `/var/lib/onetime` 0700, database 0600; env file 0600. Round trip through Caddy over HTTPS: create 200, status 200, GET reveal 405, POST reveal 200 with the same bytes, second reveal 404. A 70 KB body was refused (502 from Debian's Caddy 2.6.2, which reports the body limit that way; newer Caddy answers 413). A second container on the same folder exited 3. With the global log exclusion, a reveal during an app stop left no trace in the journal; without it, it did. |
| Rocky Linux 9 | systemd (NodeSource Node 24.22.3) + nginx 1.20.1 (self-signed) | `--check` on the fresh host passed; first run ok; second run `changed=0`; `--check` `changed=0`. Unit active with `DynamicUser=yes`, `systemd-analyze security` 1.3 OK, `/var/lib/private/onetime` 0700, database 0600. Round trip ok, 70 KB body 413. `nginx.conf`: `access_log off`, `error_log ... crit`. No secret id in the journal or in `/var/log/nginx` after the round trip, a reveal while the app was stopped (502), and a request with an unknown Host. |
| Debian 13 | systemd (NodeSource Node 24) + nginx 1.26.3 | first run ok, second run `changed=0`; round trip ok, 413; default site removed; `ONETIME_MAX_CONNECTIONS` from `onetime_env` reached the process. Upgrade to a second bundle: new release folder, `current` switched, old folder removed, process restarted, database kept. |

File limit (added 2026-11-20, controller only, no host run): `ansible-playbook --syntax-check` passes (`ansible-lint` was not installed this time). The role's assert and templates were run on the controller (`include_role` with `tasks_from: assert.yml`): the env file gets `ONETIME_MAX_FILE_BYTES` and `ONETIME_MAX_FILE_TTL`; Caddy and nginx get 307200 / 80 s by default, 5427200 / 230 s at 5242880, 102400 / 70 s at 0, and the derived values equal the formula over 23 values at every size-class boundary; 5242881, -1, a TTL of 59 or 604801, a body override below the blob and the two variables in `onetime_env` are refused. The rendered Caddyfiles pass `caddy validate` (Caddy 2 image) and the nginx files `nginx -t` (nginx stable-alpine image). With the server at 5242880 behind the rendered nginx (HTTPS) and Caddy (HTTP) files: a 5,243,298-byte body was stored (201) and revealed with the same bytes, also when sent at 30 KB/s (170 s); the default-size files refused it with 413 and accepted a 262,562-byte body.

Not tested: Ubuntu, RHEL proper (with EPEL and SELinux enforcing), Docker CE on the RHEL family, registry login and pull, `onetime_node_install: distro`, a public certificate with Caddy, real hosts and VMs, a data disk in systemd mode, backup and restore on a host.
