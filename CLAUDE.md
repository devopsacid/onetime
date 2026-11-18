# onetime

Public site for sharing a secret (password, token, credentials) through a link that works once, plus an in-browser password/token/UUID generator. No accounts. README.md describes the behaviour and API.

## Rules that must hold

- The server never sees plaintext or keys. The browser encrypts (AES-256-GCM); the key stays in the URL fragment (`/#<id>.<key>`). Nothing may send the fragment, the key or the plaintext anywhere: no analytics, no third-party requests, no logging of them.
- A link works once. Reveal is one atomic SQL statement (`DELETE ... WHERE id = ? AND expires_at > ? RETURNING blob`). Never SELECT then DELETE.
- Only `POST /api/secrets/<id>/reveal` burns a secret. GET requests (link previews, prefetch) must not.
- Expired secrets are never handed out (checked on every read). Their rows are purged on later API requests, not by a timer; keep the README and page text saying exactly that.
- No IPs, IP hashes, cookies or request logs. Observability stays off, because paths contain secret ids.
- Strict CSP in `public/_headers`: no inline script or style, no external origins. `Cache-Control: no-store` on the HTML, immutable on `/assets/*`; do not put Cache-Control on `/*` (Pages merges matching rules).
- The upload body is read as a counted stream that stops at `MAX_BLOB_BYTES`; do not go back to `request.arrayBuffer()`.
- The HTTP API contract is shared by `src/web/api.ts` and `src/worker/index.ts`; limits live in `src/shared/limits.ts`.

## Stack and layout

- Vanilla TypeScript + Vite (`index.html`, `src/web/`), output `dist/`. No framework, no runtime dependencies.
- Cloudflare Pages Function `functions/api/[[path]].ts` → router `handle()` in `src/worker/index.ts`; `public/_routes.json` limits the Function to `/api/*`.
- D1 database `onetime` (binding `DB`), schema in `migrations/`.
- Tests: Vitest in the Workers runtime via `@cloudflare/vitest-plugin` (no DOM). Put testable browser logic in DOM-free modules under `src/web/`; `main.ts` is wiring only. The router takes `options { now, maxStored }` as test hooks.
- pnpm; build scripts for `esbuild` and `workerd` are allowed in `pnpm-workspace.yaml`.

## Commands

```sh
pnpm check              # gate: typecheck (two tsconfigs), tests, build
pnpm db:migrate:local   # once, before the first local run
pnpm dev                # build + wrangler pages dev
pnpm db:migrate:remote  # apply migrations to the real D1
pnpm deploy             # build + wrangler pages deploy
```

## Deployment

- Target: Cloudflare Pages project `onetimepass` (production = `onetimepass.pages.dev`). The name `onetime` is taken on pages.dev by another account.
- Not deployed yet (2026-11-18). `database_id` in `wrangler.jsonc` is still the placeholder `REPLACE_WITH_D1_DATABASE_ID`; the D1 database has to be created and migrated first.
- Blocker on 2026-11-18: the `cloudflare-pages-token` token has Pages access but gets 401 from the D1 API. It needs Account → D1 → Edit, or the owner creates the database in the dashboard and supplies its id.
- Deploys follow the global `cf-pages-deploy` skill (explicit approval per deploy, `secrets-manager` for the token, `deployer-cloudflare` for the deploy). Because Pages Functions are included, run the deploy from the app directory, not from a temp dir.

## Known open points

- No per-IP rate limit (the Workers rate-limit binding is not available on Pages, and WAF rules need a custom domain). A global cap of 20,000 stored secrets returns 503 when full, so the cap can be filled by an attacker.
- The Back-button (bfcache) clearing of the revealed secret is implemented but was not proven in a real bfcache restore.
- There is no browser e2e test in the repo; UI flows were checked with throwaway Playwright scripts.
