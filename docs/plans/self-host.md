# Plan: self-hosting onetime outside Cloudflare

Status: draft for the owner, 2026-11-19. Base: `main` at 70054d8. Author: architect.
Nothing here has been implemented yet. Statements marked "verified" were checked on this machine or in the cited docs on 2026-11-19.

## 1. Goal and non-goals

Goal: the same code runs (a) unchanged on Cloudflare Pages + D1 and (b) as one Node process with SQLite on a plain Linux host or VM, in Docker or under systemd, behind a TLS reverse proxy. Every rule in `CLAUDE.md` "Rules that must hold" holds on both.

Non-goals:
- Serverless targets (Lambda/DynamoDB, Azure Functions/Cosmos).
- Postgres or any multi-replica setup. The storage interface leaves room for it (section 3.2), but it is not implemented.
- Managed container platforms with network-share storage in v1 (see D7; this changes the agreed direction).
- Hosting under a path prefix (`https://host/onetime/`): `src/web/api.ts` uses absolute `/api/...` paths and `cli/core.ts` `resolveServer` keeps only the origin.
- Compression, HTTP/2 and TLS in the Node server: the reverse proxy does these.
- Publishing a container image (the origin is fixed at build time, D5).

## 2. Decisions

D1. **SQLite driver: built-in `node:sqlite`.** Minimum Node **22.13** for the server, Docker uses Node 24 LTS.
- Verified: in the Node docs, `node:sqlite` was added in v22.5.0. It needs no flag since v22.13.0 and v23.4.0, and it is a release candidate (Stability 1.2) since v24.15.0 and v25.7.0 (https://nodejs.org/api/sqlite.html, https://nodejs.org/docs/latest-v24.x/api/sqlite.html). The `timeout` (busy timeout) option arrived in v22.16 and v24.0, so the store sets `PRAGMA busy_timeout` instead and works from 22.13. BLOBs come back as `Uint8Array`.
- Verified locally on Node v22.22.1 (SQLite 3.46.1) and in `node:24-alpine` (v24.22.3, SQLite 3.54.1): WAL, `INSERT ... SELECT ... WHERE (SELECT COUNT(*) ...) < ?` returns `changes` 0 or 1, `DELETE ... RETURNING blob` returns the blob once and `undefined` the second time, and bytes 0x00/0x80/0xFF round-trip. Node 22 prints `ExperimentalWarning`, Node 24.22.3 does not.
- In Node 26, `DatabaseSync` is a deprecated alias of `Database` (DEP0210). The store uses `sqlite.Database ?? sqlite.DatabaseSync`.
- Load the module with `process.getBuiltinModule("node:sqlite")` (types via `import type`). On a Node that is too old, the server can then print "Node 22.13 or newer is required" instead of failing at module load.
- Rejected: `better-sqlite3`. It is a native addon, so it needs a prebuilt binary per Node ABI and libc or a compiler toolchain in the build stage. It adds an install script to `pnpm-workspace.yaml` `allowBuilds` (supply-chain surface) and a runtime dependency, which breaks "no runtime dependencies". It brings nothing we need: RETURNING and WAL work in both.
- Node 20 is end-of-life since 2026-04-30 (https://github.com/nodejs/Release). Changes: `package.json` gets `"engines": { "node": ">=22.13" }` (repo and server) and `@types/node` moves to `^24`. The CLI bundle keeps esbuild `target: "node20"` until the owner decides otherwise (Q5).

D2. **Storage behind a small async interface; the router gets the store injected.** `handle(request, store, ctx, options)` replaces `handle(request, env, ctx, options)`. The Pages Function wraps `env.DB` in a D1 store per request. SQL stays exactly as it is today, now inside the stores. Async methods leave room for Postgres. Rejected: (a) keeping `env` and adding `options.store`, which leaves a Cloudflare type in the shared router; (b) one generic `query(sql)` adapter, which would let dialect differences leak into the router and hide the atomicity contract.

D3. **One SQLite writer, enforced.** The store opens with `PRAGMA locking_mode=EXCLUSIVE`, then `journal_mode=WAL`, then one `BEGIN IMMEDIATE; COMMIT` at startup. The process then keeps the write lock until it exits, and a second server on the same file fails at startup with a clear message (exit 3). In exclusive mode SQLite keeps the WAL index in heap memory, so no `-shm` file is created. Verified locally: second process refused, a third accepted after the first closed, no `-shm` file. Other pragmas:
- `synchronous=FULL`: with NORMAL, a power loss could roll back a committed reveal and bring a used secret back.
- `secure_delete=ON`: deleted blobs are zeroed in the main file.
- `temp_store=MEMORY`: works with a read-only root fs.
- `busy_timeout=5000` and `journal_size_limit=4194304`.
- `wal_checkpoint(TRUNCATE)` on clean shutdown.

Rejected: just documenting "one replica", which is easy to miss and fails silently.

D4. **Node server: `node:http`, zero runtime dependencies, static files from an in-memory table.**
- At startup it walks `dist/` with `lstat` (symlinks refused), loads every servable file into memory with its content type and a strong ETag, and builds a route table: clean URL to file, `.html` and trailing-slash URL to a 308.
- Requests are looked up in that table only and never joined into a filesystem path. Path traversal and directory listing are therefore impossible by construction, and `..`, NUL or backslash after decoding answer 400, as Pages does.
- Headers come from `dist/_headers`, parsed once with Pages semantics (section 3.4). Unsupported syntax refuses to start.
- `/api` and `/api/*` go to `handle()`. `_routes.json` is not read; a test pins its `include` to `["/api/*"]` so the two cannot drift.
- Rejected: express, `serve-static` and similar (dependencies, and they bring their own header and redirect behaviour); `fs.createReadStream` per request with path joining (traversal and symlink risk for no gain at this size).

D5. **Two build profiles, one switch: `ONETIME_SITE=onetimepass` (default) | `selfhost`.**
- `pnpm build` stays the owner's Pages build. Its HTML, `_headers` and public files must be byte-identical to today's (acceptance in L4).
- `pnpm build:selfhost` needs `ONETIME_ORIGIN` (an `https://` origin, or `http://localhost:<port>`). It optionally takes `ONETIME_OPERATOR_NAME` and `ONETIME_OPERATOR_CONTACT` (an email or https URL, validated and HTML-escaped).
- The selfhost profile:
  - compiles analytics out (`__GA_ENABLED__=false`, so `info.ts` does not import `analytics.ts` and the GA code is tree-shaken);
  - removes owner-only HTML blocks and un-comments selfhost blocks (section 3.5);
  - replaces `https://onetimepass.pages.dev` with `ONETIME_ORIGIN` in HTML, `robots.txt` and `sitemap.xml`;
  - removes the two Google CSP lines from the info-path rules in `dist/_headers`, so `/*` (strict) applies there;
  - points the CLI default server at `ONETIME_ORIGIN`;
  - writes `dist/_selfhost.json` (`{ "origin": ... }`; never served).
- **The Node server refuses to start without `_selfhost.json`**, so no self-hosted copy can serve a privacy page that names the owner as controller.
- Rejected: (a) default selfhost, which breaks the owner's `pnpm check` and deploy; (b) runtime placeholder substitution in the server, because check-dist would then not see the real output; (c) "doc step only", which is easy to skip and leaks to the owner's GA property.

D6. **Runtime guard for GA, in both profiles.** `initAnalytics()` does nothing unless `location.origin === "https://onetimepass.pages.dev"`. A fork deployed anywhere else, even with `pnpm build` or on its own Pages project, never loads gtag or shows the banner. Cost: Pages preview URLs (`<hash>.onetimepass.pages.dev`) also lose analytics (Q3).

D7. **Hosting targets: Linux host or VM with a local block disk only.** This challenges the agreed direction, with concrete reasons:
- SQLite: "WAL does not work over a network filesystem" (https://www.sqlite.org/wal.html, section 1). Network-share locking is the risk in any journal mode.
- ECS Fargate persists only on EFS (NFS). Azure Container Apps persists only on Azure Files, SMB or NFS (https://learn.microsoft.com/en-us/azure/container-apps/storage-mounts). App Service `/home` is shared storage, and while a new container starts "App Service continues to serve requests from the old container" (https://learn.microsoft.com/en-us/azure/app-service/configure-custom-container), so two writers overlap on a network share.
- The Lightsail container service overview documents no volumes, and scale > 1 copies the workload across nodes (https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-container-services.html), so every redeploy would empty the database.
- Docs therefore cover: plain Linux (Docker, systemd); AWS EC2 or a Lightsail instance (VM) with EBS or the instance disk; an Azure VM with a managed disk. Each says "untested by the project". Managed container platforms wait for a Postgres store (Q1).

D8. **Tests: one API contract suite, two harnesses, two Vitest configs.** `test/worker.test.ts` becomes `test/contract/api-contract.ts` (runtime-neutral). A D1 harness runs it in workerd through the existing `vitest.config.ts`; a SQLite harness runs it in Node through a new `vitest.node.config.ts`. `pnpm test` runs both. Rejected for now: one config with Vitest `projects`. The Cloudflare docs give no guidance on mixing projects and say custom environments or runners are not supported with the integration (https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/). A developer may try it in a 30-minute spike; two configs is the fallback that surely works.

D9. **Configuration by environment, validated at start (exit 2 on bad values):**

| Variable | Default | Notes |
|---|---|---|
| `HOST` | `127.0.0.1` (image: `0.0.0.0`) | bind address |
| `PORT` | `8080` | |
| `ONETIME_DB` | `./data/onetime.db` (image: `/data/onetime.db`) | directory created with mode 0700 |
| `ONETIME_DIST` | `dist` next to the server bundle | must contain `_selfhost.json` |
| `ONETIME_MAX_STORED` | `20000` (`MAX_STORED_SECRETS`) | integer 1..10,000,000 |

There is no trust-proxy setting: no IP or `X-Forwarded-*` header is read. There are no request logs and no option to enable them. stdout carries one startup line (version, port, DB path, cap); stderr carries errors without URL, id or body.

## 3. Architecture

### 3.1 Module layout

```
src/shared/limits.ts            unchanged (shared limits)
src/worker/store.ts             NEW  SecretStore interface (runtime-neutral, no node:/Cloudflare types)
src/worker/index.ts             router; uses SecretStore + WaitUntil; keeps Options { now, maxStored }
src/worker/store-d1.ts          NEW  D1 implementation (current SQL and toBytes())
src/worker/env.d.ts             unchanged
functions/api/[[path]].ts       handle(request, d1Store(env.DB), context)
server/main.ts                  NEW  entry: version check, umask 077, config, store, listen, signals
server/config.ts                NEW  pure env parsing
server/store-sqlite.ts          NEW  SqliteStore (node:sqlite), pragmas, exclusive lock, migrations
server/migrate.ts               NEW  readMigrations(dir) + apply via PRAGMA user_version
server/headers.ts               NEW  _headers parser + headersFor(path)
server/static.ts                NEW  dist walk, route table, resolve(path)
server/http.ts                  NEW  node:http handler: /healthz, /api/* bridge, static
tools/build-server.mjs          NEW  esbuild server/main.ts -> dist-server/server.mjs (platform node, target node22)
tools/site-profile.mjs          NEW  Vite plugin: define, HTML blocks, origin, _headers/robots/sitemap, _selfhost.json
tools/check-dist.mjs            profile-aware (section 3.6)
tools/check-selfhost.mjs        NEW  smoke test of the built server against dist-selfhost/
test/contract/api-contract.ts   NEW  defineApiContract(harness) (moved cases from worker.test.ts)
test/api-d1.test.ts             NEW  D1 harness + Pages Function entry test (workerd)
test/node/*.test.ts             NEW  SQLite contract, store, headers, static, http, config, shutdown (Node)
vitest.node.config.ts           NEW  include test/node/**, environment node
tsconfig.server.json            NEW  server/, src/worker/{index,store}.ts, src/shared, test/node, test/contract; types ["node"]
Dockerfile, .dockerignore       NEW
deploy/onetime.service          NEW  systemd unit (hardened)
deploy/Caddyfile.example, deploy/nginx.conf.example   NEW
docs/self-hosting.md            NEW  ops guide; README gets a short section linking to it
```

Output directories: `dist/` (Pages build, unchanged), `dist-selfhost/` (selfhost build), `dist-server/`. Add the last two to `.gitignore`. Migrations are read from `migrations/` at runtime; the image copies that folder. Server code never goes into a static root.

`tsconfig.worker.json` excludes `test/node`. `src/worker/store-d1.ts` stays in the worker tsconfig only. The router and `store.ts` must compile under both tsconfigs, and that is the guard that keeps them runtime-neutral.

### 3.2 Storage interface

```ts
// src/worker/store.ts
export interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

/** All methods take `now` (ms since epoch) so tests control the clock. A row is live while expires_at > now. */
export interface SecretStore {
  /** One atomic step: insert only if fewer than `maxStored` live rows exist. False = full. Must never overshoot under concurrency. */
  insertIfBelowCap(id: string, blob: Uint8Array<ArrayBuffer>, expiresAt: number, now: number, maxStored: number): Promise<boolean>;
  /** One atomic step: delete the live row and return its blob; null if missing or expired. Exactly one concurrent caller wins. */
  take(id: string, now: number): Promise<Uint8Array<ArrayBuffer> | null>;
  /** True if a live row exists. Never deletes or modifies it. */
  exists(id: string, now: number): Promise<boolean>;
  /** Delete rows with expires_at <= now. Frees space only; reads already enforce expiry. */
  purgeExpired(now: number): Promise<void>;
}

// server/store-sqlite.ts (Node only)
export interface ManagedStore extends SecretStore {
  ping(): Promise<void>;   // SELECT 1, for /healthz
  close(): Promise<void>;  // checkpoint(TRUNCATE) + close; idempotent
}
export function openSqliteStore(path: string, migrations: Migration[]): ManagedStore; // throws StoreLockedError
export interface Migration { name: string; sql: string } // sorted by file name
```

Mapping: D1 and SQLite use the existing statements verbatim: `INSERT ... SELECT ?1..?3 WHERE (SELECT COUNT(*) ...) < ?5`, `DELETE ... WHERE id = ? AND expires_at > ? RETURNING blob`, `SELECT 1 ...`, `DELETE ... WHERE expires_at <= ?`. A later Postgres store fits the same signatures: `DELETE ... RETURNING` exists there, and `insertIfBelowCap` would need `pg_advisory_xact_lock`, because INSERT...SELECT COUNT is not atomic under READ COMMITTED. That is why "must never overshoot" is part of the contract text. A primary-key collision keeps today's behaviour (500).

Router after the refactor: `handle(request: Request, store: SecretStore, ctx: WaitUntil, options: Options = {})`. `Options { now?, maxStored? }` stays. The Node server passes `{ maxStored: config.maxStored }`, and the doc comment changes from "test hooks" to "test hooks; maxStored is also set by the Node server". Background purges keep using `ctx.waitUntil`. In Node, `waitUntil` adds the promise to a Set that shutdown awaits, and failures are logged without request data.

### 3.3 Node HTTP layer (`server/http.ts`)

- `http.createServer({ requestTimeout: 15_000, headersTimeout: 10_000, keepAliveTimeout: 5_000, maxHeaderSize: 8192, connectionsCheckingInterval: 2_000 })`, plus `server.maxRequestsPerSocket = 100`.
- Reject `req.url` that does not start with `/` (400). Build the URL as `new URL(req.url, "http://localhost")`. The Host header is never used.
- `/healthz`: GET or HEAD, `store.ping()`, 200 `ok` or 503, `Cache-Control: no-store` and `X-Robots-Tag: noindex`. Node only, outside `/api`, so the API contract does not change.
- `/api` and `/api/*`:
  - Build a Web `Request` (method, headers, `duplex: "half"`). For POST, the body is a custom `ReadableStream` over `req` that counts bytes and stops at `MAX_BLOB_BYTES + 1`.
  - Its `cancel()` pauses and unpipes `req`, but does not destroy the socket, so the router's 413 can still be written. The 413 is sent with `Connection: close` and the socket is destroyed on `finish`.
  - Do not use `Readable.toWeb(req)`: its cancel destroys the socket before the 413 is written.
  - The response body is buffered (at most about 16 KB), and `Content-Length` is set.
  - Uncaught errors answer 500 with the router's API headers and log one line without the URL.
  - `_headers` is not applied to API responses (Pages does not apply it to Functions either; live `/api/secrets` has no CSP).
- Static: GET and HEAD only, other methods 405 with `Allow: GET, HEAD` (live answers POST `/` with 405). See 3.4.
- Shutdown on SIGTERM/SIGINT: `server.close()` and `closeIdleConnections()`, wait for in-flight requests up to 8 s (below Docker's 10 s), then `closeAllConnections()`, await the `waitUntil` set, `store.close()`, exit 0. A second signal exits 1 at once.
- Purges happen only on API requests, as today. No timers and no purge at startup, so the README sentence "removed on the next request to the API, not by a timer" stays true.

### 3.4 Static behaviour: spec taken from the live site

Captured with curl from https://onetimepass.pages.dev on 2026-11-19. The Node server must match this table, except the `Access-Control-Allow-Origin: *` that Pages adds by itself.

| Request | Live status / Location | Headers source |
|---|---|---|
| `/` | 200 | rules for `/*` + `/` |
| `/index.html`, `/index` | 308 → `/` | rules matching the request path (`/index.html` has no-store) |
| `/how-it-works` | 200 | `/*` + `/how-it-works` (detach + Google CSP) |
| `/how-it-works.html`, `/how-it-works%2ehtml` | 308 → `/how-it-works` | request-path rules |
| `/how-it-works/` | 308 → `/how-it-works` | only `/*` (strict CSP, no Cache-Control) |
| `/404` | 200 (404.html) | `/*` + `/404` |
| `/nope`, `/nope.html`, `/assets/`, `/assets/nope.js`, `/cli`, `/cli/`, `/_headers`, `/_routes.json`, `/HOW-IT-WORKS` | 404 with 404.html body | request-path rules, then **Cache-Control forced to `no-store`** (`/assets/nope.js` is not `immutable`; `/cli/` keeps `X-Robots-Tag: noindex`) |
| `/../etc/passwd`, `/%2e%2e/etc/passwd` | 400 | none |
| files without a Cache-Control rule (`/robots.txt`, `/favicon.svg`, `/cli/onetime.mjs`, `/manifest.webmanifest`) | 200 | Pages default `Cache-Control: public, max-age=0, must-revalidate` + ETag |
| `If-None-Match` matching | 304 | same headers, no body |

Content types seen live: html `text/html; charset=utf-8`; js/mjs `application/javascript`; `.webmanifest` `application/manifest+json`; svg `image/svg+xml`; png `image/png`; txt `text/plain; charset=utf-8`; xml `application/xml`; `.cmd` and `.sha256` `application/octet-stream`. Use css `text/css; charset=utf-8`, json `application/json`, and `application/octet-stream` for anything else.

Accepted deviation: live serves `//how-it-works` with 200; the Node server answers 404 (exact lookup only). Not served: names starting with `_` at the root (`_headers`, `_routes.json`, `_selfhost.json`), any dot-segment, and symlinks.

`_headers` semantics (https://developers.cloudflare.com/pages/configuration/headers/, verified):
- Rules apply in file order; every matching rule contributes.
- A header set twice is joined with `", "`.
- `! Name` removes what earlier rules added.
- `*` is a greedy splat matching zero or more characters (`/*` matches `/`); one splat per pattern.
- Header names are case-insensitive. `#` lines are comments.

Supported subset: exact paths and paths with one trailing or inner `*`. The parser refuses to start on placeholders (`:name`), absolute-URL patterns, `:splat` in values, more than 100 rules or lines over 2,000 characters. Those Pages features are unused, and silently mis-matching them would weaken the CSP.

### 3.5 Site profile mechanism (`tools/site-profile.mjs`, Vite plugin, both profiles)

- HTML markers, which web-designer places in the `*.html` sources:
  - `<!-- site:onetimepass -->` … `<!-- /site:onetimepass -->` is kept in the Pages build and removed in selfhost.
  - `<!-- site:selfhost` … `site:selfhost -->` is self-host content written inside a comment. It is removed in the Pages build and un-commented in selfhost.
  - `{{OPERATOR_NAME}}` and `{{OPERATOR_CONTACT}}` are allowed only inside selfhost blocks.
  - Marker lines are removed with their newline, so the Pages HTML stays byte-identical.
- Blocks needed:
  - privacy controller and the GA section;
  - the "Cookie settings" links (`index.html:253` and the footers);
  - the hosting sentence "Cloudflare, which hosts it" (`index.html:241`);
  - the D1 Time Travel paragraph (`how-it-works.html:359`), replaced in selfhost by SQLite wording: WAL/free pages and any backups the operator makes can keep encrypted blobs for a while;
  - the cookies/analytics FAQ in both the visible FAQ and the FAQPage JSON-LD, which must stay equal;
  - `command-line.html` install lines (handled by the origin replacement).
- Selfhost texts without an operator say the copy is run independently of onetimepass.pages.dev and does not name a controller. The docs tell operators who serve the public to set the operator variables.
- `define`: `__GA_ENABLED__` (and `__GA_ID__`) for the web build. `tools/build-cli.mjs` adds `__DEFAULT_SERVER__`, and `cli/main.ts` passes `typeof __DEFAULT_SERVER__ === "string" ? __DEFAULT_SERVER__ : DEFAULT_SERVER` into `run()`, the same pattern as `__VERSION__`. `vitest.config.ts` defines `__GA_ENABLED__: true` for the existing tests.
- Build-tool code stays `.mjs` (like the other tools), so `tsconfig.json` (`types: []`) does not need Node types.

### 3.6 check-dist and pnpm scripts

`tools/check-dist.mjs [dir]` reads the profile from `dir/_selfhost.json`.
- Pages profile: everything checked today, plus no `site:` markers left and no `_selfhost.json`.
- Selfhost profile:
  - `OWN_ORIGIN` is the `_selfhost.json` origin;
  - no `googletagmanager|google-analytics|gtag|G-W3GR41J2NR` in any file under `dir` (HTML, JS, CSS, `_headers`);
  - no `michal@maxian.sk`;
  - no `onetimepass.pages.dev` outside `cli/` (the bundle banner keeps the project URL);
  - the info paths fall back to the strict `/*` CSP (no override, no detach).

Scripts:
- `test` = `vitest run && vitest run -c vitest.node.config.ts`
- `typecheck` adds `tsc -p tsconfig.server.json --noEmit`
- `build:selfhost` = `ONETIME_SITE=selfhost` vite build to `dist-selfhost/`, then CLI build into it, then `build:server`
- `check` = typecheck → test → build → check-dist dist → build:selfhost (with `ONETIME_ORIGIN=https://onetime.example`) → check-dist dist-selfhost → check-selfhost

`check-selfhost` starts `dist-server/server.mjs` on port 0 with a temp DB, then checks: the 3.4 table for the main paths, the API round trip, `/healthz`, and that a second instance on the same DB exits 3.

## 4. Work lanes (in order)

Work on one branch `feat/self-host` in `/home/claude/onetime-selfhost`, with one commit or more per lane. L4a only edits `*.html`, so it may run in parallel with L1–L3. Every other lane is sequential, because L2–L5 all touch `package.json`. Each lane ends green on `pnpm check`. The worktree and branch are removed after the owner's ff-merge.

**L1 developer: store interface and router refactor (no behaviour change)**
- Files: `src/worker/store.ts`, `src/worker/store-d1.ts`, `src/worker/index.ts`, `functions/api/[[path]].ts`, `test/contract/api-contract.ts`, `test/api-d1.test.ts` (replaces `test/worker.test.ts`), `test/cli-helpers.ts`, `tsconfig.worker.json`.
- TDD:
  - First move every existing case into `defineApiContract(harness)` with `ApiHarness { call(path, init?, options?); rowCount(); expiresAt(id); setExpiresAt(id, ms); ids() }`. Tests use `(await r.json()) as T`, not the workers-only generic `json<T>()`. Keep the D1 harness and see it green against the old router.
  - Then switch the router to the store.
  - Add a test that `src/worker/index.ts` and `store.ts` import nothing from `node:` or `cloudflare:`.
- Acceptance:
  - Same number of test cases or more, all green.
  - The Pages Function test passes.
  - `pnpm build` output is byte-identical to main's.
  - `wrangler pages functions build` (check the exact subcommand) bundles `functions/` into `~/.tmp/...` without errors.

**L2 developer: SQLite store and Node test harness**
- Files: `server/store-sqlite.ts`, `server/migrate.ts`, `vitest.node.config.ts`, `tsconfig.server.json`, `test/node/api-sqlite.test.ts`, `test/node/store-sqlite.test.ts`, `package.json` (scripts, `engines`, `@types/node ^24`).
- TDD:
  - The contract suite against SQLite, with a fresh temp DB per test (the D1 pool isolates storage per test; the expiry test relies on an empty table).
  - The 10-parallel-reveal case.
  - After open: `journal_mode` is wal, `synchronous` is 2, `secure_delete` is 1.
  - A second process on the same file exits with `StoreLockedError` (spawn a child).
  - DB file mode `0600` under umask 077.
  - Migrations apply once (`user_version`), and a second open is a no-op. `migrations/0001_init.sql` runs unchanged.
  - Blob bytes 0..255 round-trip.
- Acceptance: both test configs green; no Node types in workerd tests or the other way round.

**L3 developer: Node server (HTTP, static, headers, config, shutdown, bundle)**
- Files: `server/{main,config,headers,static,http}.ts`, `tools/build-server.mjs`, `test/node/{headers,static,http,config,shutdown}.test.ts`, test fixtures created in temp dirs, `package.json`.
- TDD, written first:
  - Headers parser tests: merge with ", ", detach order, splat `/*` matches `/`, case-insensitive names, refusal of `:name`, absolute URLs and more than 100 rules. Run against the real `public/_headers`: the CSP per path class (strict on `/`, `/index.html`, `/404`, assets and `/cli/*`; Google CSP exactly once on the six info paths), no-store on HTML, immutable only on existing `/assets/*`.
  - Static tests: the whole 3.4 table, including 400 cases, `%2e`, NUL, backslash, symlink in dist refused at start, `_selfhost.json` not served, HEAD without body, 304.
  - HTTP tests: an over-limit chunked body gets a 413 response (not a reset), and reading stops early (fewer than `10 * MAX_BLOB_BYTES` bytes accepted); an honest oversized Content-Length gets 413 without reading; `/api/*` responses carry no CSP; `/healthz`; the timeouts configured on the server object; no log output during requests (spy on stdout/stderr).
  - Config tests: invalid values exit 2; missing `_selfhost.json` refuses.
  - Shutdown test: a request in flight completes, the DB is closed and the lock released.
- Acceptance: all green; `dist-server/server.mjs` runs on Node 22.13+ and 24; it has no runtime dependencies (esbuild bundle, `node:*` external).

**L4a web-designer: self-host copy and markers (HTML only)**
- Files: `index.html`, `privacy.html`, `how-it-works.html`, `command-line.html`.
- Work: put the 3.5 markers around owner-only text and write the selfhost variants. Privacy wording rules from `CLAUDE.md` apply, with "the host" instead of "Cloudflare". Keep the visible FAQ and the JSON-LD FAQ equal in both variants.
- Acceptance: the Pages build after L4b is byte-identical; the selfhost texts are true for the SQLite server (no timer purge, WAL/backups note, no analytics, no cookies).

**L4b developer: profiles, analytics guard, CLI default, check-dist**
- Files: `tools/site-profile.mjs`, `vite.config.ts`, `src/web/analytics-config.ts`, `src/web/info.ts`, `src/web/analytics.ts`, `tools/build-cli.mjs`, `cli/main.ts`, `tools/check-dist.mjs`, `tools/check-selfhost.mjs`, `vitest.config.ts`, `package.json`, `.gitignore`, tests in `test/consent.test.ts` and `test/cli-core.test.ts`.
- TDD:
  - Origin guard: `analyticsAllowedHere("https://onetimepass.pages.dev")` is true; `https://x.pages.dev`, `http://localhost` and `https://onetimepass.pages.dev.evil.com` are false.
  - The CLI default server is injectable; `resolveServer` behaviour is unchanged.
  - Profile transform unit tests on sample HTML (both profiles, escaping of the operator values, origin validation).
  - check-dist negative fixtures: a GA ID in selfhost, a leftover marker, a Google CSP in selfhost `_headers`.
- Acceptance:
  - `pnpm build` HTML, `_headers` and public files are byte-identical to main; JS differs only in the info chunk.
  - Selfhost check-dist is green.
  - `check-selfhost` is green.
  - The selfhost dist contains no GA code at all.

**L5 devops: Dockerfile and deploy files**
- Files: `Dockerfile`, `.dockerignore`, `deploy/onetime.service`, `deploy/Caddyfile.example`, `deploy/nginx.conf.example`.
- Dockerfile:
  - Stage 1 `node:24-slim` (glibc, because pnpm installs the workerd binary) with `corepack`, `pnpm install --frozen-lockfile` and `pnpm build:selfhost`. Build args: `ONETIME_ORIGIN` (required) and the two operator variables.
  - Stage 2 `node:24-alpine`, both base images pinned by digest. It contains `dist-selfhost/`, `dist-server/` and `migrations/`, sets `HOST=0.0.0.0` and `ONETIME_DB=/data/onetime.db`, creates `/data` owned by `node`, declares `VOLUME /data` and runs as `USER node`.
  - `HEALTHCHECK CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1` (busybox wget, no curl), `CMD ["node","dist-server/server.mjs"]`.
- systemd unit:
  - `DynamicUser=yes`, `StateDirectory=onetime`, `UMask=0077`, `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`, `NoNewPrivileges=yes`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`.
  - Not `MemoryDenyWriteExecute` (V8 JIT needs W+X).
  - `KillSignal=SIGTERM`, `TimeoutStopSec=10`.
- Proxy examples:
  - Caddy without a `log` directive (Caddy access logging is turned on by `log`; https://caddyserver.com/docs/caddyfile/directives/log), plus `request_body max_size 64KB`.
  - nginx with `access_log off;`, `error_log ... crit;` (error lines at lower levels include the request line with the id), `client_max_body_size 64k;` and timeouts.
- Verify here:
  - `docker build`;
  - `docker run --read-only --cap-drop ALL --security-opt no-new-privileges -v onetime-data:/data`: healthy, uid 1000, DB 0600, API round trip with curl, `docker stop` exits 0 in under 10 s;
  - a second container on the same volume exits 3;
  - image size under 190 MB (base `node:24-alpine` is 172 MB here);
  - Caddy (`tls internal`) and nginx in containers in front of it: TLS reaches the app, no access-log lines with `/api/secrets/`;
  - `systemd-analyze verify deploy/onetime.service`.
- Acceptance: all of the above recorded in the lane report.

**L6 devops (draft) then web-designer (wording): docs**
- Files: `docs/self-hosting.md`, `README.md` (short section, plus the Layout table rows for `server/`, `deploy/`, `Dockerfile`).
- Content:
  - Requirements: Node 22.13+ (24 recommended), or Docker.
  - HTTPS is required: browsers expose `crypto.subtle` only in a secure context, so plain http works only on `localhost`.
  - Single instance in a **boxed warning near the top**: no replicas, no network filesystems (NFS/EFS/SMB/Azure Files), stop the old container before starting the new one; the server refuses a second writer but cannot detect every network-share setup.
  - Build with `ONETIME_ORIGIN`.
  - Plain Linux with Docker or systemd, behind Caddy or nginx with access logs off.
  - AWS EC2 / Lightsail instance and Azure VM: short, each marked "not tested by the project".
  - Why managed container platforms are not supported yet.
  - Backups extend how long encrypted blobs exist.
  - The CLI: `onetime --server https://your.host` or `ONETIME_SERVER`, or the CLI downloaded from your instance, which defaults to it. Links from any instance open with any CLI build, because `get` uses the link's origin (`cli/core.ts` `parseLinkInput`).
  - HSTS `includeSubDomains` is in `public/_headers`: edit it before building if you serve from an apex domain with plain-http subdomains.
  - Optional proxy rate limiting, noting that it keeps IPs in proxy memory.
- Acceptance: every command in the docs was run in L5 or is marked untested.

**L7 code-reviewer.** Review the whole branch diff against the Rules in `CLAUDE.md` and this plan's section 5.

**L8 tester.**
- Re-run `pnpm check` and the L5 probes.
- Mutants, each must fail a test:
  - SELECT-then-DELETE reveal;
  - the count check outside the INSERT;
  - `! Name` ignored;
  - 404 keeps `immutable`;
  - no exclusive lock;
  - `_selfhost.json` check removed;
  - GA enabled in selfhost;
  - `Readable.toWeb` cancel in the bridge (413 lost).
- Curl the live site read-only and diff it against the 3.4 table.

After the merge, the owner may approve a Pages deploy. It should show no behaviour change; check with the `CLAUDE.md` curl checklist.

`CLAUDE.md` is the owner's file. Suggested updates after the merge, for the owner to apply: the stores, the `server/` layout, the two Vitest configs, `build:selfhost`, the `_selfhost.json` refusal, and "managed container platforms unsupported with SQLite".

## 5. Security checklist specific to self-hosting

- Request size: the router's counted stream stays the authority. The bridge caps at `MAX_BLOB_BYTES + 1` too, and the proxy limits the body to 64 KB.
- Slowloris and timeouts: `headersTimeout` 10 s, `requestTimeout` 15 s, keep-alive 5 s, `maxHeaderSize` 8 KB. The proxy in front is required for public exposure (TLS anyway).
- Logging: none per request in the app; proxy access logs off; nginx error log at `crit`; Docker logs contain only the startup line.
- HTTPS-only links: the page builds links from `location.origin`, so they are https when the instance is served over https; the CLI refuses non-localhost http. HSTS comes from `_headers` and is ignored by browsers on plain http.
- DB: umask 077, so the file, its directory and the WAL are 0600/0700; exclusive lock; `secure_delete`; `synchronous=FULL`. The volume belongs to uid 1000 in Docker; bind mounts need `chown 1000`.
- Container: non-root, `--read-only`, `--cap-drop ALL`, `no-new-privileges`, no shell needed at runtime except busybox for the healthcheck.
- Host header and `X-Forwarded-*` are never read.
- CSP: same `_headers` file and the same merge semantics; the selfhost build has no Google host at all; check-dist guards both profiles.
- The GA ID cannot reach the owner's property from another origin (D6), and selfhost builds contain no GA code (D5).

## 6. Risks

- `node:sqlite` is a release candidate, not stable; the API could change in a minor release. Mitigation: a thin store and contract tests on 22 and 24 (L3 acceptance), with the Docker image pinned by digest.
- Byte-identical Pages HTML depends on careful marker placement (L4a/L4b). Mitigation: a diff against main's build in L4b acceptance.
- The Node bridge differs from workerd's request handling (Content-Length mismatch, chunked bodies). The contract suite runs only against `handle()`; the HTTP tests in L3 cover the bridge itself.
- Exclusive lock behaviour on network filesystems is unreliable, so the guard is best effort there; the docs forbid network filesystems.
- The live Pages behaviour in 3.4 was observed, not documented; Cloudflare may change it. The table is the spec for the Node server, not a promise about Pages.

## 7. Open questions for the owner

Q1. Drop managed container platforms (Lightsail container service, ECS Fargate+EFS, Azure Container Apps, App Service) from v1, documenting VMs only (D7)? They return with a Postgres store.
Q2. OK that `pnpm build` stays the Pages profile, and that the Node server refuses to start without a selfhost build (D5)?
Q3. OK that the runtime origin guard (D6) also turns analytics off on Pages preview URLs?
Q4. In the selfhost build, are the operator name and contact optional (generic text) or required?
Q5. Node versions: server minimum 22.13 (with an ExperimentalWarning on 22) or 24.15+ only? Should the CLI keep claiming Node 20 now that Node 20 is end-of-life?
Q6. Pin pnpm with a `packageManager` field for reproducible Docker builds?
Q7. Selfhost default for search engines: keep robots/sitemap with the operator's origin (planned), or default to `Disallow: /` for private instances?
Q8. OK to add the selfhost build and smoke test to `pnpm check` (a few more seconds per run)?

## 8. What can and cannot be verified from this machine

Can be verified (Node v22.22.1 and Docker 26.1.4 are available):
- all unit and integration tests, and `pnpm check`;
- Node 24 in Docker (`node:24-alpine` already pulled);
- image build and run, `--read-only`, healthcheck, stop/lock behaviour;
- Caddy and nginx configs in containers with local TLS;
- `systemd-analyze verify` of the unit;
- read-only curl comparison with the live Pages site;
- `wrangler pages functions build` for the unchanged Pages bundle.

Cannot be verified:
- AWS (EC2, Lightsail) and Azure (VM) deployments: no accounts or credentials here; the docs say so;
- real public TLS certificates and DNS;
- macOS/Windows hosts;
- behaviour on network filesystems;
- a Pages deploy without the owner's explicit approval.

## 9. Defaults chosen for the open questions (2026-11-19, pending the owner's confirmation)

The owner asked to start implementation as soon as the plan was ready, so these defaults apply until the owner says otherwise:

- Q1: yes. v1 documents Linux VMs only (plain Linux, AWS EC2 / Lightsail instance, Azure VM). Managed container platforms come back with a Postgres store.
- Q2: yes. `pnpm build` stays the Pages profile; the Node server refuses a build without `_selfhost.json`.
- Q3: yes. Analytics only on `https://onetimepass.pages.dev`, also off on Pages preview URLs.
- Q4: optional. Without `ONETIME_OPERATOR_NAME` / `ONETIME_OPERATOR_CONTACT` the privacy page uses generic text ("the operator of this instance"); the docs tell operators to set both.
- Q5: server minimum Node 22.13 (the ExperimentalWarning on 22 is documented), Docker uses Node 24. The CLI docs say Node 22+; `engines` for the CLI is not tightened in code.
- Q6: yes, pin pnpm with `packageManager`.
- Q7: self-host builds default to `Disallow: /` and no sitemap; `ONETIME_INDEXABLE=1` at build time switches to robots + sitemap with the operator's origin.
- Q8: yes, `pnpm check` includes the self-host build and the smoke test.

## Deviations (recorded during L1-L3 implementation, 2026-11-19)

- `@types/node` moved to `^24` (D1) with `pnpm add -D`; only that package and its lockfile entries changed. `engines.node >=22.13` added. The `packageManager` pin (Q6) is not part of L1-L3 and is still open.
- `openSqliteStore` returns a `SqliteStore` (`ManagedStore` plus a read-only `db` handle). With the exclusive lock no second connection can look at rows, so the contract harness and the store tests need the connection that holds it. The server code only uses `ManagedStore`.
- During lock acquisition `busy_timeout` is 0, so a second server refuses at once instead of after 5 s; it is set to 5000 right after the lock is held.
- Prepared statements are created on first use, so a database without the `secrets` table (migration tests) can open.
- `ONETIME_DIST` defaults to `dist-selfhost` next to `dist-server/` (D9 said "`dist` next to the server bundle"; the self-host build writes `dist-selfhost/`, section 3.1). Migrations are read from `migrations/` next to `dist-server/`.
- One file more than 3.1 lists: `server/start.ts` (open store, load site, listen, `shutdown()`), so the shutdown path is testable without a process; `server/main.ts` only does the version check, umask, exit codes and signals.
- 3.3 says the 413 socket is destroyed on `finish`. Destroying with unread request data makes the kernel send a reset that can swallow the response, so the bridge ends its side (`Connection: close`) and destroys the socket after 1 s if the client keeps sending. The request stays paused, so reading still stops early.
- `src/worker/index.ts` now exports `API_HEADERS` so the bridge can answer a 500 with the router's headers; nothing else in the router changed.
- `server.connectionsCheckingInterval` is a constructor option only (no property), so the HTTP test checks the other timeouts and the maxRequestsPerSocket property.
- `vitest.config.ts` (workerd) excludes `test/node/**`; `tsconfig.worker.json` excludes `test/node`.
- Exit codes of `server/main.ts`: 2 bad config, missing or invalid site folder or `_selfhost.json`, or Node too old; 3 database locked; 1 anything else. On Node 22 the `ExperimentalWarning` from `node:sqlite` goes to stderr (tests run the server with `--no-warnings`).

## Deviations (recorded during L4b implementation, 2026-11-19)

- The origin guard lives in its own module `src/web/analytics-origin.ts` (not in `consent.ts`, 3.5 does not say), because `consent.ts` sits in a chunk shared with `main.ts`. In `consent.ts` the new export would have changed the shared `ga-cookies` chunk and with it the hash in every page. The test for it is still in `test/consent.test.ts`.
- Byte-identity of `pnpm build` vs main (`git archive main`, built in a temp dir, `diff -r`): `_headers`, all public files, `404.html`, `index.html`, `main`, `ga-cookies` and `notFound` chunks are identical. Differences: the `info` chunk (guard) and therefore the `<script src>` hash in the three info pages (`how-it-works`, `command-line`, `privacy`); and the CLI bundle `dist/cli/onetime.mjs` (+ its `.sha256`), because `resolveServer` gets the injectable default server (`Io.defaultServer`, 3.5). The plan's "JS differs only in the info chunk" therefore also covers the CLI bundle.
- `@pnpm/exe` platform packages: adding `packageManager` (Q6) made pnpm 12 write a `packageManagerDependencies` document (158 lines) at the top of `pnpm-lock.yaml`; without it `pnpm install --frozen-lockfile` refuses. No project dependency changed. Pinned `pnpm@12.16.1` (the version in use; lockfileVersion 9.0).
- The site-profile logic is split into `tools/site-profile-core.mjs` (pure, tested in Node, with `.d.mts` typings so `tsconfig.json`/`tsconfig.server.json` need no Node types or `allowJs`) and `tools/site-profile.mjs` (the Vite plugin, which also sets `outDir` and `__GA_ENABLED__`, so `vite.config.ts` stays free of `process.env`). Operator names containing `{{` or `}}`, control characters or more than 200 characters are rejected; contact values over 200 characters too.
- `ONETIME_ORIGIN` must be an exact origin (no path, no trailing slash); `http` only for `http://localhost:<port>`.
- The selfhost dist still contains the small `ga-cookies` chunk used by `main.ts` (deletes `_ga*` cookies if present; contains no GA loader, host or ID). `check-dist` selfhost forbids `googletagmanager|google-analytics|analytics.google|gtag|G-W3GR41J2NR` everywhere, which this chunk passes.
- Selfhost builds that are not indexable only write `robots.txt` with `Disallow: /`; no `noindex` header or meta tag is added.
- `check` sets `ONETIME_ORIGIN=https://onetime.example` for the self-host build. The `build:selfhost` script uses a POSIX `VAR=value cmd` prefix (Linux/macOS shells only).
- `check-selfhost` additionally checks that the Pages `dist/` is refused (exit 2) when it exists, and sends the dot-dot targets over a raw socket because `fetch` normalises them.
