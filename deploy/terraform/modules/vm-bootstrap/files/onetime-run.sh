#!/bin/sh
# Runs the onetime container in the foreground for onetime.service. Same hardening as compose.yaml: read-only root,
# no capabilities, no-new-privileges, port on loopback only, small local log. Runs as the host system user onetime.
set -eu
IMAGE=$(cat /etc/onetime/image)
# The image comes from onetime-pull (with the VM identity); never let docker run try an anonymous pull.
docker image inspect "$IMAGE" >/dev/null 2>&1 || /usr/local/sbin/onetime-pull
exec /usr/bin/docker run --rm --name onetime \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --user "$(id -u onetime):$(id -g onetime)" \
  --publish 127.0.0.1:8080:8080 \
  --volume /var/lib/onetime:/data \
  --env-file /etc/onetime/env \
  --log-driver local --log-opt max-size=1m --log-opt max-file=2 \
  --stop-timeout 10 --pull never \
  "$IMAGE"
