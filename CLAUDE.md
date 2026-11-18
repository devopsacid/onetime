# onetime

Public site for sharing a secret (password, token, credentials) through a link that works once, plus an in-browser password/token/UUID generator. No accounts. README.md describes the behaviour and API.

## Rules that must hold

- The server never sees plaintext or keys. The browser encrypts (AES-256-GCM); the key stays in the URL fragment (`/#<id>.<key>`). Nothing may send the fragment, the key or the plaintext anywhere: no analytics, no third-party requests, no logging of them.
- A link works once. Reveal is one atomic SQL statement (`DELETE ... WHERE id = ? AND expires_at > ? RETURNING blob`). Never SELECT then DELETE.
- Only `POST /api/secrets/<id>/reveal` burns a secret. GET requests (link previews, prefetch) must not.
- Expired secrets are never handed out (checked on every read). Their rows are purged on later API requests, not by a timer; keep the README and page text saying exactly that.
- No IPs, IP hashes, cookies or request logs, because paths contain secret ids. Pages configs reject the `observability` key, so logging is controlled in the dashboard: keep Functions logs and Logpush off there.
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

- Live: Cloudflare Pages project `onetimepass`, production https://onetimepass.pages.dev (production branch `main`), first deployed 2026-11-18 from `206e1c7` and checked with curl. The name `onetime` is taken on pages.dev by another account.
- Pages adds `access-control-allow-origin: *` to static files by itself; the API responses do not carry it. Harmless for a public static page.
- D1 database `onetime` (id `20cbacad-c40a-4e7b-9a0e-3203078ecb3b`, region EEUR) was created and `0001_init.sql` applied remotely on 2026-11-18. New schema changes go in a new file under `migrations/`, applied with `pnpm db:migrate:remote` before the deploy that needs them.
- Credentials: `pass` entry `cloudflare-token-write` (account-owned token with Pages and D1 access), account `2badee882679b77acf215905e6efcfd2`. `cloudflare-pages-token` has no D1 access and cannot deploy this project's database.
- Deploys follow the global `cf-pages-deploy` skill (explicit approval per deploy, `secrets-manager` for the token, `deployer-cloudflare` for the deploy). Because Pages Functions are included, run the deploy from the app directory, not from a temp dir.

## Known open points

- No per-IP rate limit (the Workers rate-limit binding is not available on Pages, and WAF rules need a custom domain). A global cap of 20,000 stored secrets returns 503 when full, so the cap can be filled by an attacker.
- The Back-button (bfcache) clearing of the revealed secret is implemented but was not proven in a real bfcache restore.
- There is no browser e2e test in the repo; UI flows were checked with throwaway Playwright scripts.
