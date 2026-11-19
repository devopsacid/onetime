# Self-hosted onetime. The site origin is fixed at build time, so there is no published image: build your own.
#   docker build --build-arg ONETIME_ORIGIN=https://onetime.example -t onetime .
# Optional build args: ONETIME_OPERATOR_NAME, ONETIME_OPERATOR_CONTACT, ONETIME_INDEXABLE (1 = robots.txt + sitemap).
# Base images are pinned by digest (index digests, so they work on amd64 and arm64). Update them on purpose.

# Stage 1: build. Debian (glibc) because pnpm installs the workerd binary for the test tooling.
FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
ARG ONETIME_ORIGIN
ARG ONETIME_OPERATOR_NAME
ARG ONETIME_OPERATOR_CONTACT
ARG ONETIME_INDEXABLE
RUN test -n "$ONETIME_ORIGIN" || { echo "Build arg ONETIME_ORIGIN is required, e.g. --build-arg ONETIME_ORIGIN=https://onetime.example" >&2; exit 1; }
WORKDIR /src
# The exact pnpm version comes from "packageManager" in package.json.
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build:selfhost

# Stage 2: runtime. Only the three folders the server needs.
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 ONETIME_DB=/data/onetime.db
WORKDIR /app
COPY --from=build /src/dist-selfhost ./dist-selfhost
COPY --from=build /src/dist-server ./dist-server
COPY --from=build /src/migrations ./migrations
# /data belongs to the node user (uid 1000); a named volume copies this ownership on first use.
RUN mkdir /data && chown node:node /data && chmod 0700 /data
VOLUME /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "dist-server/server.mjs"]
