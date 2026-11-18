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

## Command line

`onetime` is a single Node file (Node 20 or newer is the only requirement; no other dependencies). It is compatible with the web page: links made by one can be opened by the other, and it encrypts on your machine, so the server never sees the secret or the key.

Install on Linux or macOS:

```sh
curl -fsSL https://onetimepass.pages.dev/cli/onetime.mjs -o onetime && chmod +x onetime
# or skip chmod and run it as: node onetime.mjs ...

# optional: verify the download
curl -fsSL https://onetimepass.pages.dev/cli/onetime.mjs.sha256 -o onetime.mjs.sha256
# (the file names onetime.mjs; save the download under that name, or compare the hashes by eye)
sha256sum -c onetime.mjs.sha256        # macOS: shasum -a 256 -c onetime.mjs.sha256
```

The checksum is served from the same site as the script, so it catches a damaged download, not a compromised server.

Only Linux has been tested so far; Windows and macOS have not been run yet.

Install on Windows (PowerShell), into a folder that is on your PATH:

```powershell
Invoke-WebRequest https://onetimepass.pages.dev/cli/onetime.mjs -OutFile onetime.mjs
Invoke-WebRequest https://onetimepass.pages.dev/cli/onetime.cmd -OutFile onetime.cmd
```

Examples (on Windows, use `node onetime.mjs` or the `onetime.cmd` shim in place of `./onetime`):

```sh
echo -n 'hunter2' | ./onetime send            # prints the link; hints go to stderr
./onetime send --ttl 1h                       # no pipe: type the secret at a hidden prompt
./onetime gen --type password --length 32     # generate and share in one step, secret not shown
./onetime gen --print-only --type uuid        # just print a secret, no server contact
./onetime get -                               # paste the link at the prompt / read it from stdin
./onetime status "https://onetimepass.pages.dev/#<id>.<key>"   # still waiting? exit 0 or 1
```

`onetime get "<link>"` also works and prints exactly the secret (a newline is added only on a terminal). Opening a link with `get` uses it up, like the Reveal button. `onetime --help` lists everything; exit codes: 0 ok, 1 gone (already opened or expired), 2 usage error, 3 damaged link, 4 decryption failed, 5 network or server error, 70 internal error. The server defaults to `https://onetimepass.pages.dev`; change it with `--server <url>` or `ONETIME_SERVER` (https only, except `http://localhost` and `http://127.0.0.1`).

Security notes:

- The secret is never accepted as an argument, because arguments land in shell history and the process list. Pipe it in or use the hidden prompt.
- A link given as an argument to `get` or `status` ends up in shell history, and the key is part of the link. Use `onetime get -` or `onetime get` and paste it, or open it in a browser. For the same reason `send` and `gen` never print the link in their hints, only on stdout.
- Links to `http://localhost` or `http://127.0.0.1` are accepted only when `--server` or `ONETIME_SERVER` names that same server.
- Input must be valid UTF-8 (or UTF-16 with a byte order mark) and at most 16 KB of text; anything else is refused instead of being altered.
- `gen` prints only the link; `--show` prints the secret to stderr too.
- No telemetry, config files or update checks.
- Windows PowerShell may change the encoding or add line endings when piping text. Use the interactive prompt or `gen` there. The CLI strips one trailing newline and understands UTF-8 and UTF-16 byte order marks, but this has not been tried on Windows.

## Layout

| Path | What |
|---|---|
| `index.html`, `src/web/` | The page: encryption, generator, UI (vanilla TypeScript, built by Vite) |
| `how-it-works.html` | The detailed explanation of how secrets are stored (second Vite entry, script `src/web/page.ts`) |
| `public/theme-init.js` | Tiny synchronous script in `<head>` that applies a stored light/dark choice before first paint (no inline script, so the CSP holds) |
| `functions/api/[[path]].ts` | Cloudflare Pages Function for `/api/*`; delegates to the router |
| `src/worker/index.ts` | The API router, storing blobs in D1 |
| `migrations/` | D1 schema (`secrets` table) |
| `src/shared/limits.ts` | Size and expiry limits used by both sides |
| `public/_headers`, `public/_routes.json` | CSP and other security headers for the static files; the Function runs only for `/api/*` |
| `cli/`, `tools/build-cli.mjs` | The `onetime` command line tool (bundled by esbuild into `dist/cli/onetime.mjs`, served at `/cli/onetime.mjs`) |
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

Deploying to the Cloudflare Pages project `onetimepass` (needs a Cloudflare login or API token):

```sh
wrangler d1 create onetime      # once; put the printed id in wrangler.jsonc (database_id)
pnpm db:migrate:remote          # apply migrations to the remote database
pnpm deploy                     # build and `wrangler pages deploy`
```
