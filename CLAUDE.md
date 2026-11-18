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
- In progress on branch `feat/explainer-theme` (2026-11-18): a dedicated "how it works" page explaining storage, and a light/dark theme toggle (near-black dark theme, choice kept in localStorage, set before first paint by an external script because the CSP forbids inline scripts). SEO work follows on the same branch.
- Any statement on the site about security or storage must match the code. Facts that are easy to get wrong: expired data is removed on the next request, not by a timer; D1 keeps its own recovery history for a while (encrypted blobs only); opening a link does not use it up, pressing Reveal does; the code is not claimed to be open source or audited.
- Secret links keep everything after `#`, so search engines never see ids or keys. `/api/*` must stay out of crawling and indexing.

## Known open points

- No per-IP rate limit (the Workers rate-limit binding is not available on Pages, and WAF rules need a custom domain). A global cap of 20,000 stored secrets returns 503 when full, so the cap can be filled by an attacker.
- The Back-button (bfcache) clearing of the revealed secret is implemented but was not proven in a real bfcache restore.
- There is no browser e2e test in the repo; UI flows were checked with throwaway Playwright scripts.
