# onetime

Share a password, token or other secret with a link that works once. Anyone can use it; there are no accounts.

## How it works

1. The browser encrypts the secret with a new random AES-256-GCM key.
2. Only the encrypted blob is sent to the server. The link is `https://<host>/#<id>.<key>`; the part after `#` is never sent by browsers, so the server cannot read the secret.
3. The recipient opens the link and presses **Reveal**. The server returns the blob and deletes it in the same step. A second attempt gets "no longer available".
4. A secret nobody opens expires after 1 hour, 1 day or 7 days. Expired secrets are never handed out (checked on every read). Their encrypted data is removed on the next request to the API, not by a timer, so on an idle site it can stay stored, still unreadable without the key, until then.

The page can also generate passwords, random tokens (hex or base64url) and UUIDs, all in the browser.

What the server holds: the encrypted blob and its expiry time, until first read, or until the first API request after expiry. No plaintext, keys, IP addresses, accounts, cookies, analytics or request logs.

The reveal is one atomic SQL statement (`DELETE ... RETURNING`), so of many simultaneous attempts exactly one gets the blob.

Opening the link does not use it up; only the Reveal button does. This keeps link previews in chat apps from destroying the secret.

## Layout

| Path | What |
|---|---|
| `index.html`, `src/web/` | The page: encryption, generator, UI (vanilla TypeScript, built by Vite) |
| `functions/api/[[path]].ts` | Cloudflare Pages Function for `/api/*`; delegates to the router |
| `src/worker/index.ts` | The API router, storing blobs in D1 |
| `migrations/` | D1 schema (`secrets` table) |
| `src/shared/limits.ts` | Size and expiry limits used by both sides |
| `public/_headers`, `public/_routes.json` | CSP and other security headers for the static files; the Function runs only for `/api/*` |
| `test/` | Vitest tests, run inside the Workers runtime |

API: `POST /api/secrets?ttl=<seconds>` (body: blob) → `{ id }`; `GET /api/secrets/<id>` → exists or 404; `POST /api/secrets/<id>/reveal` → blob, then deleted.

Limits: 16 KB per secret. There is no per-IP rate limit (IPs are never stored). Instead, creating returns 503 while 20,000 unexpired secrets are stored.

## Commands

```sh
pnpm install
pnpm db:migrate:local   # once: create the local D1 database (.wrangler/state)
pnpm dev                # build, then run Pages locally at http://localhost:8788
pnpm check              # typecheck, tests, build
```

Deploying to the Cloudflare Pages project `onetime` (needs a Cloudflare login or API token):

```sh
wrangler d1 create onetime      # once; put the printed id in wrangler.jsonc (database_id)
pnpm db:migrate:remote          # apply migrations to the remote database
pnpm deploy                     # build and `wrangler pages deploy`
```
