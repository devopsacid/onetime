# onetime

Public site for sharing a secret (password, token, credentials) through a link that works once, plus an in-browser password/token/UUID generator. No accounts. README.md describes the behaviour and API.

## Rules that must hold

- The server never sees plaintext or keys. The browser encrypts (AES-256-GCM); the key stays in the URL fragment (`/#<id>.<key>`). Nothing may send the fragment, the key or the plaintext anywhere: no analytics, no third-party requests, no logging of them. The app page `/` and `404.html` never load or reference Google or any other third-party code; analytics exists only on the info pages (see "Analytics").
- A link works once. Reveal is one atomic SQL statement (`DELETE ... WHERE id = ? AND expires_at > ? RETURNING blob`). Never SELECT then DELETE.
- Only `POST /api/secrets/<id>/reveal` burns a secret. GET requests (link previews, prefetch) must not.
- Expired secrets are never handed out (checked on every read). Their rows are purged on later API requests, not by a timer; keep the README and page text saying exactly that.
- No IPs, IP hashes, cookies or request logs, because paths contain secret ids. Pages configs reject the `observability` key, so logging is controlled in the dashboard: keep Functions logs and Logpush off there.
- Strict CSP in `public/_headers`: no inline script or style, no external origins. `Cache-Control: no-store` on the HTML, immutable on `/assets/*`; do not put Cache-Control on `/*` (Pages merges matching rules).
- The upload body is read as a counted stream that stops at `MAX_BLOB_BYTES`; do not go back to `request.arrayBuffer()`.
- The HTTP API contract is shared by `src/web/api.ts` and `src/worker/index.ts`; limits live in `src/shared/limits.ts`.

## Stack and layout

- Vanilla TypeScript + Vite (`index.html`, `src/web/`), output `dist/`. No framework, no runtime dependencies.
- Cloudflare Pages Function `functions/api/[[path]].ts` → router `handle(request, store, ctx, options)` in `src/worker/index.ts`; `public/_routes.json` limits the Function to `/api/*`. The router is runtime-neutral (no `node:` or `cloudflare:` imports, a test enforces it) and talks to a `SecretStore` (`src/worker/store.ts`): `store-d1.ts` for Pages, `server/store-sqlite.ts` for self-hosting. Both keep the same single SQL statements.
- D1 database `onetime` (binding `DB`), schema in `migrations/`.
- Tests: two Vitest configs. `vitest.config.ts` runs in the Workers runtime via `@cloudflare/vitest-plugin` (no DOM, D1); `vitest.node.config.ts` runs `test/node/` in Node (SQLite store, Node server, site profiles). The API contract suite `test/contract/api-contract.ts` runs against both stores, including concurrency and a structural check that reveal and capped insert are single statements. Put testable browser logic in DOM-free modules under `src/web/`; `main.ts` is wiring only. The router takes `options { now, maxStored }` as test hooks.
- pnpm; build scripts for `esbuild` and `workerd` are allowed in `pnpm-workspace.yaml`.

## Command-line client

- `cli/core.ts` (pure, tested in the Workers runtime with `fetch` wired to the real router) and `cli/main.ts` (Node entry). `tools/build-cli.mjs` bundles them with esbuild into `dist/cli/onetime.mjs`, plus `onetime.cmd` (Windows shim) and `onetime.mjs.sha256`; the site serves them at `/cli/`. Node 22+ is the only requirement; no runtime dependencies.
- It reuses `src/web/crypto.ts`, `generate.ts`, `link.ts` and the shared limits, so links are interchangeable with the web page. Do not fork the crypto; change the shared modules and keep both sides tested.
- Rules: the secret is never accepted as an argument (stdin or hidden prompt only); stdout carries only the link (`send`, `gen`) or only the secret (`get`); hints on stderr never contain the link or key; server replies are size-capped and the returned id is validated; https only, except an explicitly named local server.
- `pnpm build` = `vite build` then `build:cli` (vite empties `dist/` first). `dev` and `deploy` go through `pnpm build`.
- Run on Linux only so far; Windows and macOS are untested (the README says so).

## Commands

```sh
pnpm check              # gate: typecheck (4 tsconfigs), both test configs, Pages build + check-dist,
                        #       self-host build + check-dist + check-selfhost (server smoke test)
pnpm db:migrate:local   # once, before the first local run
pnpm dev                # build + wrangler pages dev
pnpm db:migrate:remote  # apply migrations to the real D1
pnpm deploy             # build + wrangler pages deploy
ONETIME_ORIGIN=https://host pnpm build:selfhost   # self-host site + CLI + dist-server/server.mjs
```

## Deployment

- Live: Cloudflare Pages project `onetimepass`, production https://onetimepass.pages.dev (production branch `main`), first deployed 2026-11-18 from `206e1c7` and checked with curl. The name `onetime` is taken on pages.dev by another account.
- Pages adds `access-control-allow-origin: *` to static files by itself; the API responses do not carry it. Harmless for a public static page.
- D1 database `onetime` (id `20cbacad-c40a-4e7b-9a0e-3203078ecb3b`, region EEUR) was created and `0001_init.sql` applied remotely on 2026-11-18. New schema changes go in a new file under `migrations/`, applied with `pnpm db:migrate:remote` before the deploy that needs them.
- Credentials: `pass` entry `cloudflare-token-write` (account-owned token with Pages and D1 access), account `2badee882679b77acf215905e6efcfd2`. `cloudflare-pages-token` has no D1 access and cannot deploy this project's database.
- Deploys follow the global `cf-pages-deploy` skill (explicit approval per deploy, `secrets-manager` for the token, `deployer-cloudflare` for the deploy). Because Pages Functions are included, deploy from a clean `git archive` of the commit that contains `functions/` and `wrangler.jsonc`: `pnpm exec wrangler pages deploy --project-name onetimepass --branch main --commit-hash <sha> --commit-dirty=false`.
- After a deploy, check with curl: `/` headers (CSP equals `public/_headers`, `no-store`), assets `immutable`, and the API round trip (create → status 200 → GET reveal 405 → POST reveal returns the same bytes → second reveal 404).
- Lessons from the first deploy: Pages configs reject keys such as `observability`, `main` and `assets` (wrangler validates before uploading); an active token can still lack a permission, so probe Pages and D1 read-only first; the Claude Code permission check blocked `wrangler pages project create` inside a subagent, so creating a new Cloudflare resource may need the owner's go-ahead in the main session.

## How work is done here

- The owner wants implementation done by the specialised subagents from the global CLAUDE.md, not by the main session: `developer` (Function, D1, tests), `frontend-dev` (browser code), `web-designer` (public pages and content), `ui-designer`, `seo-expert`, `code-reviewer` before a merge, `secrets-manager` and `deployer-cloudflare` for deploys.
- Feature work goes on a branch in a worktree next to the repo (e.g. `/home/claude/onetime-<topic>`), is reviewed, then fast-forward merged into `main`; remove the worktree and the merged branch afterwards. Agents that edit the same files run one after another, not in parallel.
- No global git identity is configured on this machine. Commit with `git -c user.name="Michal Maxian" -c user.email="michal@maxian.sk" commit ...`. Nothing has been pushed; push only when asked.
- Never deploy a commit whose `pnpm check` is not green.

## Pages and content

- `index.html` is the app (create, created, open, revealed, gone views toggled with `hidden`).
- Other pages (Vite multi-page, inputs in `vite.config.ts`): `how-it-works.html` (how a secret is stored: diagram, link anatomy, stored / not stored, deletion, limits of protection, FAQ), `command-line.html` (CLI install and usage), `privacy.html` (controller Michal Maxian, contact, what is stored, Google Analytics details, `#cookies` section), `404.html` (noindex; without it Pages serves the app with 200 for unknown paths). Pages serves them at extensionless URLs (`/how-it-works`, `/command-line`, `/privacy`); links, canonicals and the sitemap use that form. Every new HTML path needs its own `Cache-Control: no-store` lines in `public/_headers`.
- Theme: light and near-black dark, tokens in `src/web/style.css` for `[data-theme]` plus the `prefers-color-scheme` fallback when nothing is chosen. `public/theme-init.js` is the one classic script in `<head>` (sets `data-theme` before first paint; accepts only `light`/`dark`); logic in `src/web/theme.ts`, wiring in `theme-toggle.ts`. Besides the consent record, the theme choice is the only thing saved in the browser (localStorage), and the privacy texts say so.
- SEO: per-page title, description, canonical, Open Graph/Twitter tags and JSON-LD data blocks (allowed by the CSP because they are not executed; the FAQPage block must equal the visible FAQ text), `public/robots.txt`, `public/sitemap.xml` (update `lastmod` when a page changes), `og-image.png` (source `og-image.svg`), icons and `manifest.webmanifest` (needs `manifest-src 'self'` in the CSP). `X-Robots-Tag: noindex` on `/cli/*` and on all API responses; transient app views carry `data-nosnippet`.
- `tools/check-dist.mjs` is the last step of `pnpm check`: it fails on inline scripts or styles, event-handler attributes, external resources and invalid JSON-LD in `dist/*.html`; on Google strings in `index.html`, `404.html` or any chunk they load; and on `dist/_headers` drifting (Google hosts only in the info-path rules, no `'unsafe-inline'`, `/*` CSP exactly the strict one, no CSP override on `/` or `/404`).
- Privacy wording must stay exact: the site's own code stores no accounts, cookies or IP addresses; the secret page sets no cookies, runs no analytics and loads nothing external; the info pages use Google Analytics only after Accept, and that data is personal (IP, device, client-id cookie), never call it anonymous; Cloudflare as host handles connections (IP, request details) like any host; do not write "nothing about you is kept".
- Any statement on the site about security or storage must match the code. Facts that are easy to get wrong: expired data is removed on the next request, not by a timer; D1 keeps its own recovery history for a while (encrypted blobs only); opening a link does not use it up, pressing Reveal does; the code is MIT-licensed (`LICENSE`, also noted in the CLI bundle banner) but is not claimed to be audited.
- Secret links keep everything after `#`, so search engines never see ids or keys. `/api/*` must stay out of crawling and indexing.

## Analytics (added 2026-11-19, owner's decision)

- GA4 `G-W3GR41J2NR` via gtag.js only, no Google Tag Manager (the owner's GTM-TZKWX9H8 snippet was deliberately not used). The ID lives in `src/web/analytics-config.ts`; an empty or non-`G-` ID disables banner and loading.
- Only on `/how-it-works`, `/command-line` and `/privacy`, only after Accept in the consent banner (Consent Mode v2 defaults denied, then only `analytics_storage` granted; signals and ad personalization off; cookies 12 months; `page_location` without query or fragment; one custom event `cli_download`). Reject sends nothing; Cookie settings in every footer; revoke deletes `_ga*` and reloads.
- Code split: `src/web/consent.ts` + `ga-cookies.ts` (no Google strings, also used by `/` to delete leftover `_ga*`), `analytics.ts` imported only by the info-page entry `info.ts`. Keep it that way; check-dist enforces it.
- CSP: the info paths (with and without `.html`) detach the `/*` CSP with `! Content-Security-Policy` and set the strict policy plus Google hosts. A new info page needs the same rules and check-dist's path list updated.
- GA admin (owner's side): retention 2 months (the privacy page says so), Google signals, granular location/device data, data sharing and Enhanced Measurement off, no Ads link.
- Browser behaviour was checked with a throwaway Playwright script (Google hosts stubbed, 87 checks), not a repo e2e.

## Self-hosting (added 2026-11-19)

- Guide: `docs/self-hosting.md`; plan, decisions and recorded test results: `docs/plans/self-host.md` (incl. Deviations sections).
- Node server `server/` (plain `node:http`, no runtime deps, Node 22.13+; Docker uses Node 24), bundled by `tools/build-server.mjs` into `dist-server/server.mjs`. It loads `dist-selfhost/` into memory at start (no filesystem lookups per request), applies `public/_headers` with Pages' merge and `!` detach semantics, mimics Pages URLs (extensionless, 308s, `404.html` with 404), logs nothing per request, never reads Host/X-Forwarded-*. Over-limit bodies get 413 after a bounded drain. Exit codes: 2 config, 3 DB locked, 1 other.
- SQLite via `node:sqlite`: exclusive lock (one server per DB file; a second exits 3), WAL, `synchronous=FULL`, `secure_delete`, umask 077, migrations from `migrations/` tracked by `user_version`. Single instance only: no replicas, no network filesystems; managed container platforms (ECS Fargate/EFS, Azure Container Apps/App Service, Lightsail containers) are not supported until a Postgres store exists.
- Two site profiles from the same HTML (`tools/site-profile*.mjs`, markers `<!-- site:onetimepass -->` / `<!-- site:selfhost ... site:selfhost -->`): `pnpm build` is the Pages site; `pnpm build:selfhost` needs `ONETIME_ORIGIN` (optional `ONETIME_OPERATOR_NAME`, `ONETIME_OPERATOR_CONTACT`, `ONETIME_INDEXABLE=1`), drops analytics, owner data and the Google CSP, and writes `_selfhost.json`; the server refuses any dist without it. Non-indexable builds (default) send `X-Robots-Tag: noindex` and `Disallow: /`.
- Analytics also has a runtime origin guard: it loads only on exactly `https://onetimepass.pages.dev` (off on preview URLs and forks).
- Deploy files: `Dockerfile` (digest-pinned, non-root, `VOLUME /data`), `compose.yaml`, `deploy/onetime.service` (systemd, hardened), `deploy/Caddyfile.example`, `deploy/nginx.conf.example` (access logs off; nginx default sites must be removed). AWS/Azure VM instructions and running the systemd unit are untested (the guide says so).
- `packageManager` pins pnpm 12.16.1; `pnpm install --frozen-lockfile` needs the lockfile's `packageManagerDependencies` block.
- Text changes on the pages must keep both profiles true; check-dist checks both outputs.

## Known open points

- No per-IP rate limit (the Workers rate-limit binding is not available on Pages, and WAF rules need a custom domain). A global cap of 20,000 stored secrets returns 503 when full, so the cap can be filled by an attacker.
- The Back-button (bfcache) clearing of the revealed secret is implemented but was not proven in a real bfcache restore.
- There is no browser e2e test in the repo; UI flows were checked with throwaway Playwright scripts.
- Some Node tests start real servers and can time out when the machine is very loaded (load average 40+); a rerun passes.
