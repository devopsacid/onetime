# onetime

Share a password, token, other secret or small file with a link that works once. Anyone can use it; there are no accounts.

## How it works

1. The browser pads the secret to a fixed size class and encrypts it with AES-256-GCM. The key is derived (HKDF-SHA-256) from a new random key, and with an optional passphrase also from the passphrase (PBKDF2-SHA-256, 600,000 rounds). A file (up to 256 KB on the hosted service) works the same way; its name and type are encrypted together with its contents.
2. Only the encrypted blob is sent to the server. The link is `https://<host>/#2.<id>.<key>` (`2p` when a passphrase is needed, `2f` for a file, `2fp` for a file with a passphrase); older links of the form `https://<host>/#<id>.<key>` still open. The part after `#` is never sent by browsers, so the server cannot read the secret.
3. The recipient opens the link and presses **Reveal**. The server returns the blob and deletes it in the same step. A second attempt gets "no longer available". A wrong passphrase destroys the secret: there is one try. A file is only offered as a download, never shown in the page. The sender can check whether a link is still waiting without using it up: open it and do not press Reveal, or run `onetime status -`.
4. A secret nobody opens expires after 1 hour, 1 day or 7 days; a file after 1 hour at most (a self-hosted server can allow longer with `ONETIME_MAX_FILE_TTL`). Expired secrets are never handed out (checked on every read). Their encrypted data is removed on the next request to the API, not by a timer, so on an idle site it can stay stored, still unreadable without the key, until then.

The page can also generate passwords, random tokens (hex or base64url) and UUIDs, all in the browser.

What the server holds: the encrypted blob and its expiry time, until first read, or until the first API request after expiry. The blob shows its format, whether a passphrase is needed, whether it is a file, and its size class; never a file's name, type or contents. No plaintext, keys, passphrases, IP addresses, accounts, cookies or request logs. The page where secrets are created and opened loads nothing from other sites and has no analytics or cookies. The information pages (how it works, privacy) live on a separate site, `https://onetimepass-info.pages.dev`, which is its own entry on the Public Suffix List and so a different origin and site from the app. Only that site uses Google Analytics 4, and only after an explicit Accept in a consent banner (see its privacy page). The app origin (`https://onetimepass.pages.dev`) serves no Google code on any path: one strict CSP in `public/_headers` covers every path, and the old `/how-it-works` and `/privacy` URLs there redirect (301) to the info site. Each site keeps only its own theme choice in local storage; the consent record exists on the info site only.

The reveal is one atomic SQL statement (`DELETE ... RETURNING`), so of many simultaneous attempts exactly one gets the blob.

Deleted is not the same as gone everywhere. On the hosted site, Cloudflare D1 keeps its own point-in-time recovery history (Time Travel) for 7 days, and it cannot be turned off. It holds only encrypted blobs, never keys, but someone with access to the database account and the full old link could recover an opened secret during that window. A self-hosted instance deletes rows with SQLite's `secure_delete`, but copies can survive in the WAL file and in the operator's backups or disk snapshots. Either way, treat a sent link as sensitive even after it was opened. Until Reveal is pressed, the full link is also in the recipient's browser history, which browser sync may copy to the vendor's servers.

Opening the link does not use it up; only the Reveal button does. This keeps link previews in chat apps from destroying the secret.

## Command line

`onetime` is a single Node file (Node 22 or newer is the only requirement; no other dependencies). It is compatible with the web page: links made by one can be opened by the other, and it encrypts on your machine, so the server never sees the secret or the key.

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
./onetime send --passphrase                   # also asks for a passphrase, twice (needs a terminal)
./onetime send --passphrase-file pass.txt < secret.txt   # passphrase from the first line of a file
./onetime send --file report.pdf --ttl 1h     # one file (up to 256 KB hosted; the server's limit is checked first); files last 1 hour by default
tar czf - notes | ./onetime send --file - --name notes.tar.gz   # a file from a pipe
./onetime gen --type password --length 32     # generate and share in one step, secret not shown
./onetime gen --print-only --type uuid        # just print a secret, no server contact
./onetime get -                               # paste the link at the prompt / read it from stdin
./onetime get - -o ~/Downloads/               # save a file into a folder (or -o new-name.pdf)
./onetime status "https://onetimepass.pages.dev/#<id>.<key>"   # still waiting? exit 0 or 1
```

`onetime get "<link>"` also works and prints exactly the secret (a newline is added only on a terminal). Opening a link with `get` uses it up, like the Reveal button. A link that needs a passphrase asks for it at a hidden prompt, or reads the first line of `--passphrase-file PATH`. A file link needs `-o PATH` (a folder, or a file name that does not exist yet; nothing is ever overwritten) or redirected output; on a terminal without `-o` nothing is opened. `onetime --help` lists everything; exit codes: 0 ok, 1 gone (already opened or expired), 2 usage error (also a missing passphrase, an existing target, or a file link on a terminal without `-o`; nothing is opened), 3 damaged link (nothing is opened), 4 decryption failed (also a wrong passphrase; the link is used up), 5 network or server error, or the file could not be written after it was opened, 70 internal error.

Links made since 2026-11-20 need version 0.3.0 or newer; older versions report them as damaged without using them up. Files above 1 MiB (self-hosted servers only) need 0.4.0. `send --file` asks the server for its limits (`GET /api/limits`) and refuses an over-limit file before uploading; an older server without that call is treated like the hosted service. `onetime --version` shows the version. The server defaults to `https://onetimepass.pages.dev`; change it with `--server <url>` or `ONETIME_SERVER` (https only, except `http://localhost` and `http://127.0.0.1`).

Security notes:

- The secret is never accepted as an argument, because arguments land in shell history and the process list. Pipe it in or use the hidden prompt.
- A link given as an argument to `get` or `status` ends up in shell history, and the key is part of the link. Use `onetime get -` or `onetime get` and paste it, or open it in a browser. For the same reason `send` and `gen` never print the link in their hints, only on stdout.
- Links to `http://localhost` or `http://127.0.0.1` are accepted only when `--server` or `ONETIME_SERVER` names that same server.
- Input must be valid UTF-8 (or UTF-16 with a byte order mark) and at most 16 KB of text; anything else is refused instead of being altered.
- `gen` prints only the link; `--show` prints the secret to stderr too.
- The passphrase is never accepted as an argument either (`--passphrase=...` is refused). `--passphrase` needs a terminal; with a piped secret use `--passphrase-file`.
- `get -o` creates the target with mode 0600 and never overwrites or follows a symlink at the final name. A file's name is cleaned (no path parts, control or bidi characters, reserved Windows names) before it is used.
- No telemetry, config files or update checks.
- Windows PowerShell may change the encoding or add line endings when piping text. Use the interactive prompt or `gen` there. The CLI strips one trailing newline and understands UTF-8 and UTF-16 byte order marks, but this has not been tried on Windows.

## Layout

| Path | What |
|---|---|
| `index.html`, `src/web/` | The page: encryption, generator, UI (vanilla TypeScript, built by Vite) |
| `privacy.html` | Privacy page (built into `dist-info/`, the info site): controller, what is stored, Google Analytics on the info site only after consent, cookies |
| `command-line.html` | Install and usage of the command-line client (app site; Vite entry, script `src/web/page.ts`, no analytics) |
| `how-it-works.html` | The detailed explanation of how secrets are stored (built into `dist-info/`, the info site; Vite entry, script `src/web/info.ts`; `src/web/page.ts` serves 404.html and command-line.html) |
| `public/theme-init.js` | Tiny synchronous script in `<head>` that applies a stored light/dark choice before first paint (no inline script, so the CSP holds) |
| `functions/api/[[path]].ts` | Cloudflare Pages Function for `/api/*`; delegates to the router |
| `src/worker/index.ts` | The API router, storing blobs in D1 |
| `migrations/` | D1 schema (`secrets` table) |
| `src/shared/limits.ts` | Size and expiry limits used by both sides |
| `public/_headers`, `public/_routes.json` | CSP and other security headers for the static files (the info build derives its own `_headers` from this file); the Function runs only for `/api/*` |
| `tools/burn-id.mjs` | Deletes a reported link by its id without opening it (abuse reports; works for any instance) |
| `tools/site-profile*.mjs`, `tools/deploy-info.mjs` | The three builds (app `dist/`, info `dist-info/`, self-host `dist-selfhost/`) and the info site deploy script |
| `cli/`, `tools/build-cli.mjs` | The `onetime` command line tool (bundled by esbuild into `dist/cli/onetime.mjs`, served at `/cli/onetime.mjs`) |
| `server/`, `tools/build-server.mjs` | Self-hosted Node server (HTTP, static files, SQLite store), bundled into `dist-server/server.mjs` by `pnpm build:selfhost` |
| `Dockerfile`, `compose.yaml`, `deploy/` | Self-hosting: Docker image, Compose file, systemd unit, Caddy and nginx examples |
| `docs/self-hosting.md` | Self-hosting guide for operators |
| `test/` | Vitest tests: the Cloudflare side runs inside the Workers runtime, `test/node/` runs in Node |

API: `GET /api/limits` → `{ "maxFileBytes": 262144, "maxFileTtl": 3600, "maxTextBytes": 16384 }` (the file size in bytes, 0 when files are off, the longest life of a file in seconds, and the text size; hosted values here, a self-hosted server answers its settings; `no-store`); `POST /api/secrets?ttl=<seconds>` (body: blob, at most 262,562 bytes on the hosted service; blobs over 16,418 bytes may last at most `maxFileTtl` seconds (1 hour hosted), otherwise `409` with `maxTtl: 3600`) → `{ id }`; `GET /api/secrets/<id>` → exists or 404; `POST /api/secrets/<id>/reveal` → blob, then deleted.

Limits: 16 KB per text secret, 256 KB per file on the hosted service (a self-hosted server sets `ONETIME_MAX_FILE_BYTES`, up to 5 MiB; see `docs/self-hosting.md`). Files last at most 1 hour by default (self-hosting: `ONETIME_MAX_FILE_TTL`); the server cannot tell a small file from a text, so it enforces this only by size: it refuses any blob over 16,418 bytes with an expiry longer than 1 hour (`409`, `maxTtl: 3600`). Texts keep 1 hour, 1 day or 7 days. There is no per-IP rate limit (IPs are never stored). Instead, creating returns 503 while 20,000 secrets are stored, counting every secret not yet revealed (expired ones not yet purged count, but every create purges them first). While more than 80 % of that is in use (16,000), creating a link that lasts longer than 1 day is refused with `409` and `{"error": ..., "maxTtl": 86400}`; the web page and the CLI tell the sender and ask for a shorter expiry. The same rule applies against the operator's `ONETIME_MAX_STORED` when self-hosting. Stored bytes are capped too: all blobs together at most 400 MB, and blobs over 16,418 bytes (files over about 16 KB) are accepted only while the total stays at or below 200 MB, so texts keep their room. An attacker can fill that file budget, which blocks larger files for everyone for up to an hour; only a rate limit would fix that.

## Commands

```sh
pnpm install
pnpm db:migrate:local   # once: create the local D1 database (.wrangler/state)
pnpm dev                # build, then run Pages locally at http://localhost:8788 (links to the info pages go to the production info site)
pnpm check              # typecheck, tests, build (app, CLI, info), then tools/check-dist.mjs on dist/ and dist-info/ and the self-host build
```

Deploying to the Cloudflare Pages project `onetimepass` (needs a Cloudflare login or API token):

```sh
wrangler d1 create onetime      # once; put the printed id in wrangler.jsonc (database_id)
pnpm db:migrate:remote          # apply migrations to the remote database
pnpm deploy                     # build and `wrangler pages deploy`
```

The information site is a second Pages project, `onetimepass-info` (static only: no Function, no D1), created once with `wrangler pages project create onetimepass-info --production-branch main`. Deploy it first, then the app, from the same commit: `pnpm deploy:info` (runs `tools/deploy-info.mjs`, which starts wrangler from an empty directory outside the repo so that no `functions/` or `wrangler.jsonc` is picked up). The app redirects the old info URLs to it, so it must answer before the app is deployed.

## Self-hosting

You can run your own copy on a Linux host or VM: one Node process with one SQLite file (Docker, or Node 22.13 or newer), behind a reverse proxy that provides HTTPS. HTTPS is required, because browsers allow the encryption only in a secure context (plain http works only on `localhost`). Run one instance only, and keep the database off network filesystems.

The public address is set at build time, so you build your own image. To try it on your machine:

```sh
ONETIME_ORIGIN=http://localhost:8080 docker compose up -d --build
```

[docs/self-hosting.md](docs/self-hosting.md) covers Docker Compose, plain Docker, systemd, Caddy and nginx, cloud VMs, backups and troubleshooting. Managed container platforms are not supported yet.

## License

MIT, see [LICENSE](LICENSE). Copyright (c) 2026 Michal Maxian.
