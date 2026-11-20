# ADR: one-time file transfer (phase A: small files in the database; phase B: large files, outline)

Status: proposed 2026-11-20, nothing implemented. Builds on blob format v2 (`docs/plans/blob-v2.md`, branch `sec/blob-v2`, not merged yet); work starts only after that branch is merged into `main`.

## Recommendation

1. **Agree with the small-file-first split, with two conditions.** Phase A stores files of at most **1 MiB** as ordinary encrypted blobs in the existing `secrets` table, so the burn stays the one `DELETE ... RETURNING` statement and no new Cloudflare product is involved. Conditions: (a) a **measurement spike** (task A0) must show that a 1 MiB blob survives the Workers Free CPU (10 ms) and per-isolate memory (128 MB) limits, because D1 converts BLOBs to and from JavaScript arrays with `Array.from`; if it fails, the same code ships with a lower hosted maximum (256 KiB, else 16 KB). (b) Files get their own **byte budget**, because 200 uploads of 1 MiB would otherwise use storage that 20,000 text secrets need.
2. **Phase B (R2, chunked encryption, files up to tens of MB) waits for a rate limit** (custom domain + WAF, `docs/plans/security-hardening.md` item 7) and needs its own ADR. Without a rate limit, R2's free 10 GB is filled in minutes and the burn is no longer one statement.
3. A file is a blob v2 with the **file bit in the flags byte** and the links `#2f.<id>.<key>` / `#2fp.<id>.<key>`. Every client that exists today (v1-only web, CLI 0.1.0, blob-v2 web and CLI 0.2.0) rejects those links as damaged **before** Reveal.
4. File name and MIME type sit **inside** the encrypted, padded payload. The browser offers the file only as a download: `<a download>` on a `blob:` URL of type `application/octet-stream`. It never renders or previews anything and never navigates to the file. The CSP stays exactly as it is.

## Context (facts this plan relies on)

| Fact | Source | Status |
|---|---|---|
| D1 max row, string or BLOB size: 2 MB (2,000,000 bytes), Free and Paid | https://developers.cloudflare.com/d1/platform/limits/ | verified 2026-11-20 |
| D1 max database size 500 MB (Free), 10 GB (Paid); 5 GB per account (Free) | same | verified |
| D1 max SQL statement length 100,000 bytes (bound parameters are not part of the statement text) | same | verified (limit); the "not part of the text" reading is an inference, covered by test A6 |
| D1 Time Travel: 7 days (Free), 30 days (Paid), always on | https://developers.cloudflare.com/d1/reference/time-travel/ | verified |
| Whether Time Travel history counts toward the 500 MB database size | neither the limits nor the Time Travel page says | **unverified**; checked in spike A0 |
| D1 Free: 5 million rows read, 100,000 rows written per day; queries fail after that until 00:00 UTC | https://developers.cloudflare.com/d1/platform/pricing/ | verified |
| An index adds a written row when a write touches the indexed column | same | verified |
| Whether trigger writes (the `stats` row update) count as rows written | the pricing page does not say | **unverified** |
| D1 returns a BLOB to JavaScript as an `Array`; `ArrayBuffer` and views are converted with `Array.from` | https://developers.cloudflare.com/d1/worker-api/ | verified |
| Workers Free: 10 ms CPU per request, 100,000 requests per day; 128 MB memory per isolate, shared by the concurrent requests of that isolate | https://developers.cloudflare.com/workers/platform/limits/, https://developers.cloudflare.com/workers/platform/pricing/ | verified |
| Request body limit set by the zone plan: 100 MB on Free/Pro (`pages.dev` presumably counts as Free) | workers limits page | limit verified; the `pages.dev` part is **unverified** (irrelevant for 1 MiB) |
| Pages Functions are billed and limited as Workers requests | https://developers.cloudflare.com/pages/functions/pricing/ | verified (the page does not state CPU limits; this plan assumes the Workers ones apply) |
| R2 free tier: 10 GB-month storage, 1 million Class A and 10 million Class B operations per month, free egress, DeleteObject free | https://developers.cloudflare.com/r2/pricing/ | verified (phase B only) |
| R2 lifecycle rules count in days; objects go "within 24 hours" after expiry | https://developers.cloudflare.com/r2/buckets/object-lifecycles/ | verified (phase B only) |
| CSP does not govern a `<a download>` navigation to a same-origin `blob:` URL; a `blob:` document inherits its creator's policy container | CSP Level 3 (no `navigate-to`), HTML spec | from the specs, **not verified in browsers**; proven by the e2e tests in A12 |

Code state: blob v2 code in `sec/blob-v2` (`src/web/crypto.ts`, `padding.ts`, `link.ts`, `passphrase.ts`, `open-flow.ts`, `cli/core.ts`); counter row `stats(stored)` with triggers in `migrations/0002_counter.sql`; capped insert in `src/worker/store-d1.ts` and `server/store-sqlite.ts`; near-full rule in `src/worker/index.ts` (`docs/plans/near-full-ttl.md`). The proxy examples cap bodies at 64 KB (`deploy/nginx.conf.example` `client_max_body_size 64k`, `deploy/Caddyfile.example` `max_size 64KB`), and so does the nginx template on branch `infra/deploy`.

## Decisions (phase A)

### A-1. Link and blob marking

- Link grammar (extends blob-v2 decision 1): `FORMAT = "2" / "2p" / "2f" / "2fp"`, so `FORMAT_PATTERN = /^2f?p?$/`. Today's `parseFragment` (two segments only) and blob-v2's `/^2p?$/` both answer `"invalid"`: the web shows "This link is incomplete" and the CLI exits 3, in both cases before any reveal request.
- `SecretLink` and `LinkKey` gain `file: boolean`; `buildLink` writes `2`, `2p`, `2f`, `2fp`.
- Flags byte (blob byte 1): bit 0 = passphrase, bit 1 = file; valid values `0x00`-`0x03`. It is part of the AAD (bytes 0-1), as in v2. The reader requires byte 1 to equal exactly the flags the link implies, before decryption.
- KDF unchanged (blob-v2 decision 3). The file bit is bound by the AAD, so no new HKDF info string is needed.
- Accepted leak: whoever holds the database (operator, Cloudflare, a Time Travel restore) sees from byte 1 that a blob is a file, and roughly how large it is (bucket). Name, type and content stay hidden. Hiding the kind as well would need a version-3 layout for texts too; not worth it, because the size already gives files over 16 KB away.

### A-2. Payload layout (inside the padded block)

The padded block is still `uint32-BE L ‖ payload (L bytes) ‖ zero bytes`, as in v2. For files, the payload is:

| Offset | Size | Field | Rule |
|---|---|---|---|
| 0 | 1 | `N` name length | 1-255 |
| 1 | N | name, UTF-8 | strict UTF-8; the writer stores `safeFileName(original)` |
| 1+N | 1 | `T` type length | 0-127 |
| 2+N | T | MIME type, ASCII | the writer stores `cleanMime(file.type)`, which may be empty |
| 2+N+T | L−2−N−T | content | 1 to `MAX_FILE_BYTES` bytes |

- The reader fails with exactly the same error as a GCM failure if: N = 0; T > 127; the lengths overrun L; the content is empty or larger than `MAX_FILE_BYTES`; the name is not valid UTF-8; or the padding is not zero. It does **not** trust the name or type: it shows `safeFileName(name)`, and shows the type only if `cleanMime(type)` returns it unchanged.
- `FILE_META_MAX = 4 + 1 + 255 + 1 + 127 = 388` (prefix included).
- File buckets (block sizes in bytes; the blob adds 30 = 2 header + 12 IV + 16 tag):

| Block | Blob | Holds any file up to |
|---|---|---|
| 1,024 | 1,054 | 636 B |
| 4,096 | 4,126 | 3,708 B |
| 16,388 | 16,418 | 16,000 B |
| 65,924 | 65,954 | 64 KiB |
| 131,460 | 131,490 | 128 KiB |
| 262,532 | 262,562 | 256 KiB |
| 524,676 | 524,706 | 512 KiB |
| 1,048,964 | 1,048,994 | 1 MiB |

  The first three blocks equal the v2 text buckets, so small files and texts have the same blob sizes. Above 16 KiB the buckets double, so padding at most doubles the stored size. Powers of four would hide one more bit of size but waste up to four times the space, and storage is the scarce resource here. Readers accept all eight sizes from the first deploy; the hosted writer limit can stay lower (A-4) without a format change.
- `padding.ts` is generalised: `pad(payload, buckets)` / `unpad(block, buckets, maxPayload)`. Text keeps `V2_BUCKETS` and `MAX_SECRET_BYTES`; files use `FILE_BUCKETS` and `MAX_FILE_BYTES + 2 + 255 + 127`.

### A-3. File names and types (`src/web/filename.ts`, DOM-free, shared by web and CLI)

`safeFileName(raw: string): string` applies these steps in order:
1. `raw.normalize("NFC")`.
2. Keep only the part after the last `/` or `\`.
3. Remove every code point in `\p{Cc}`, `\p{Cf}`, `\p{Zl}` or `\p{Zp}`. This removes C0/C1 controls, DEL, all bidi controls (U+202A-202E, U+2066-2069, U+200E/F, U+061C), zero-width characters, BOM, soft hyphen and tag characters.
4. Replace each of `< > : " | ? *` with `_`.
5. Strip leading and trailing spaces and dots, so there are no hidden dotfiles and no trailing dot that Windows would drop.
6. If the part before the first dot, case-insensitive, is `CON`, `PRN`, `AUX`, `NUL`, `COM0`-`COM9`, `LPT0`-`LPT9`, or `COM`/`LPT` followed by `¹ ² ³`, prefix `_`.
7. If the result is longer than 200 UTF-8 bytes, keep the extension (the last `.xxx` when it is 1-16 ASCII alphanumerics) and cut the stem at a code point boundary so that the total is at most 200 bytes.
8. If nothing is left, use `onetime-file.bin`.

`riskyFile(name): boolean`: true if the final extension (lowercased) is one of: `exe msi msix appx bat cmd com scr pif cpl ps1 psm1 vbs vbe js jse wsf wsh hta lnk url dll sys jar app dmg pkg command sh bash zsh csh run bin apk ipa iso img vhd vhdx deb rpm docm xlsm pptm dotm xlam html htm xhtml svg mht mhtml shtml xml reg scf inf`; also when the name has two extensions and the last one is in the list (`report.pdf.exe`).

`cleanMime(raw)`: lowercase, cut at the first `;`, trim; return it if it matches `/^[a-z0-9][a-z0-9.+-]{0,62}\/[a-z0-9][a-z0-9.+-]{0,62}$/`, otherwise `""`. The type is used **only as display text**, never as the Blob type and never to choose behaviour.

`formatBytes(n)`: `"412 bytes"`, `"15.6 KB"`, `"1.0 MB"` (1 KB = 1,024 bytes, one decimal place). It is used in the UI and the CLI hints.

### A-4. Limits (`src/shared/limits.ts`)

```ts
export const MAX_FILE_BYTES = 1024 * 1024;              // hosted writer limit; lowered by A0 if needed
export const FILE_META_MAX = 388;
export const FILE_BUCKETS = [1024, 4096, MAX_SECRET_BYTES + 4, ...[64, 128, 256, 512, 1024].map((k) => k * 1024 + FILE_META_MAX)] as const;
export const MAX_TEXT_BLOB_BYTES = MAX_SECRET_BYTES + 4 + 30;   // 16,418: largest text blob (was MAX_BLOB_BYTES)
export const MAX_BLOB_BYTES = FILE_BUCKETS.at(-1)! + 30;        // 1,048,994: largest blob the router reads
export function fileBlobBytes(maxFile: number): number;         // smallest blob size whose block holds maxFile + 388
export const LARGE_MAX_TTL_SECONDS = 24 * 60 * 60;              // blobs > MAX_TEXT_BLOB_BYTES
export const FILE_MAX_TTL_SECONDS = 24 * 60 * 60;               // client rule for every file
export const MAX_STORED_BYTES = 400_000_000;                    // all blobs together
export const MAX_LARGE_STORED_BYTES = 200_000_000;              // large blobs insert only while the total stays under this
```

- **Large blob** = more than 16,418 bytes. The server cannot tell files from texts (v1 blobs start with random bytes), so every rule goes by size. In practice only files are large.
- Why 400 MB and 200 MB: the database limit is 500 MB. Today's worst case for text alone is 20,000 × 16,418 = 328 MB, which stays possible. The 100 MB margin is for SQLite page overhead, the index and free pages (and Time Travel, if it counts; spike A0 checks). A large insert needs `total + size ≤ 200 MB`, so files can never take the room above 200 MB, which stays reserved for texts. If texts already fill more than 200 MB, large files are refused: texts are the core service.
- `fileBlobBytes(MAX_FILE_BYTES)` must equal `MAX_BLOB_BYTES` while the hosted limit is 1 MiB. If A0 lowers `MAX_FILE_BYTES`, the router passes `maxBlobBytes = fileBlobBytes(MAX_FILE_BYTES)` instead (the format does not change).

### A-5. Capacity: one statement for rows and bytes

Migration `migrations/0003_bytes.sql`, written so that it is correct even if D1 does not run the file as one transaction:

```sql
-- Bytes of all stored blobs, next to the row count. The capped insert checks both in one statement.
ALTER TABLE stats ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER secrets_stats_insert AFTER INSERT ON secrets
BEGIN
  UPDATE stats SET stored = stored + 1, bytes = bytes + length(NEW.blob) WHERE id = 1;
END;
CREATE TRIGGER secrets_stats_delete AFTER DELETE ON secrets
BEGIN
  UPDATE stats SET stored = stored - 1, bytes = bytes - length(OLD.blob) WHERE id = 1;
END;
DROP TRIGGER secrets_counter_insert;
DROP TRIGGER secrets_counter_delete;
-- Between the CREATE and the DROP both triggers ran (over-count only = stricter, never overshoot); this resets it exactly.
UPDATE stats SET stored = (SELECT COUNT(*) FROM secrets),
                 bytes  = (SELECT COALESCE(SUM(length(blob)), 0) FROM secrets) WHERE id = 1;
```

- One trigger per event (not separate count and byte triggers) keeps the extra writes per create and reveal at today's level, whatever D1 counts.
- Insert, the same text in `store-d1.ts` and `store-sqlite.ts`:
  `INSERT INTO secrets (id, blob, expires_at) SELECT ?1, ?2, ?3 WHERE (SELECT stored < ?4 AND bytes + length(?2) <= ?5 FROM stats WHERE id = 1)`.
  A missing stats row makes the subquery NULL, so there is no insert and the existing `CounterMissingError` path applies.
- `SecretStore.insertIfBelowCap(id, blob, expiresAt, maxStored, maxBytes)`: a new required parameter, documented as "bytes of all stored blobs after this insert must stay ≤ maxBytes".
- Router (`src/worker/index.ts`), in this order after the body is read:
  1. `large = blob.byteLength > MAX_TEXT_BLOB_BYTES`.
  2. `large && ttl > LARGE_MAX_TTL_SECONDS` → `409 { error: "Secrets larger than 16 KB can last at most 1 day.", maxTtl: 86400 }`. The `maxTtl` shape is the near-full one, so today's clients already handle it.
  3. Purge as today.
  4. `rowCap = longTtl ? longTtlCap(maxStored) : maxStored`; `byteCap = large ? maxLargeBytes : longTtl ? longTtlCap(maxStoredBytes) : maxStoredBytes`.
  5. Refused + `longTtl` → 409 near-full (unchanged); otherwise 503 (unchanged text and `Retry-After`).
- `Options` gains `maxStoredBytes`, `maxLargeBytes` (defaults from limits). `maxBlobBytes` is derived: `maxLargeBytes === 0 ? MAX_TEXT_BLOB_BYTES : MAX_BLOB_BYTES`, so an instance with files off answers 413 straight away instead of 503 after reading. `readBounded` and the `Content-Length` early check use it.
- Near-full interaction: large blobs never have long TTLs (step 2), so the near-full rule only affects small blobs. They now need both under 80 % of the rows (16,000) and under 80 % of the bytes (320 MB).

### A-6. TTL for files

Files may last 1 hour or 1 day (default 1 day). The web file mode lists only those two options. The CLI refuses `--file` with `--ttl` above 86,400 (exit 2, "Files can last at most 1 day."). The router enforces it for large blobs (A-5 step 2). Reasons: a file blocks the large budget for at most a day, and a link that someone abuses for distribution lives at most a day.

### A-7. Browser: create

- The create view gets a two-option switch, "Text" / "File" (radio inputs, keyboard accessible), and a visible `<input type="file">` (single file, no `accept`). Dropping a file onto the card also works, but the input always stays visible.
- The size is checked from `file.size` **before** reading: 0 → "The file is empty."; over the limit → "Files can be at most 1 MB." (from `formatBytes(MAX_FILE_BYTES)`). Only then `file.arrayBuffer()`.
- `encryptFile({ name, type, bytes }, passphrase?)` in `crypto.ts` builds the payload (A-2), pads, encrypts and zeroes its plaintext buffers. The passphrase works exactly as for text and gives a `2fp` link.
- Upload: `createSecret(blob, ttl, signal)` with an `AbortController`. The button reads "Encrypting…", then "Uploading 1.0 MB…", next to a **Cancel** button. `fetch` gives no upload progress, so the state is indeterminate (accepted for at most 1 MiB; phase B needs real progress). Cancel aborts. If the server had already stored the blob, that row is orphaned: nobody has the key, it expires within the TTL, and it counts against the budget until then.
- Error mapping: 413 → "This server does not accept files this large."; 503 after a large blob → "There is no room for files right now. Try again later or send a smaller file."; 409 with `maxTtl` → existing handling.
- The created view shows "File: `<name>` (`<size>`)" for the sender (local data only), plus the existing hints. The file input is reset after a successful create and on `pagehide`.

### A-8. Browser: open, save, failures

- Open view for `2f`/`2fp`: heading "Someone sent you a file". Text: "The file name and contents are encrypted. You see them after pressing Reveal. It can be downloaded only once: keep this page open until you have saved it." The passphrase field works as for `2p`.
- Reveal: the existing open flow (derive the key first, then reveal) with `revealSecret(id, { onProgress, maxBytes: MAX_BLOB_BYTES })`. The body is read through a reader, and progress shows as a percentage of `Content-Length`. There is **no Cancel after Reveal**: the row is deleted when the request is answered, so cancelling would only lose the file.
- Revealed-file view: the name (`textContent` only), size, type (if clean); a warning box when `riskyFile(name)` is true ("This kind of file can run code on your device. Open it only if you expected it from the sender."); always the note "Files are not checked for viruses: the service cannot see them." Buttons: **Save file** and **Discard**.
- Save (`src/web/download.ts`, the **only** module allowed to call `URL.createObjectURL`): `new Blob([bytes], { type: "application/octet-stream" })`, then `createObjectURL`, then set `href` and `download = safeFileName(name)` on the `#file-save` `<a>`. The user's own click triggers the download, and saving again is allowed while the page is open. Discard, `pagehide` and "Share another secret" call `revokeObjectURL`, drop the Blob reference and `fill(0)` the decrypted bytes (best effort: the Blob's internal copy cannot be wiped; the page text says the file stays only in this tab).
- **Never**: a Blob of any other type; a `blob:` or `data:` URL in `src`, `iframe`, `object`, `embed`, `img`, `video`, `audio`, `source`, `link` or `srcdoc`; `window.open` or `location` set to a file URL; a preview of any file, including images and text; `innerHTML` with the name. Rendering decrypted HTML or SVG on the app origin would be stored XSS against the secret page. Two layers of defence: the forced `application/octet-stream` (a browser that ignores `download` still downloads instead of rendering) and the unchanged CSP, which a `blob:` document inherits.
- **CSP unchanged**: no `blob:` in any directive. If a browser refuses the download, the page shows "Your browser blocked the download." and keeps the bytes so the user can try another way. The e2e tests prove that Chromium, Firefox and WebKit download.
- Failure after the burn: if the network drops while reading, or decryption fails, the gone view shows "The file was deleted from the server but did not arrive complete. Ask the sender to send it again." (or the wrong-passphrase text for `2fp`). Nothing can be retried, by design (one statement, one burn). Phase B must improve this.
- The key leaves the address bar when the file is handed over (as for text, `onPhase("revealed")`).

### A-9. CLI (`cli/core.ts`, `cli/main.ts`; version 0.3.0)

- `send --file PATH`: reads at most `MAX_FILE_BYTES + 1` bytes through `Io.readFile`; the name is `safeFileName(basename(PATH))`, the type is empty. `send --file -` reads raw bytes from stdin (no UTF-8 check, no newline stripping) and needs a pipe (TTY → exit 2 "Pipe the file in, or give a path."). `--name NAME` overrides the name (sanitised). Over the limit → exit 2 "The file is too large (limit 1.0 MB)."; empty → exit 2. `--file -` with `--passphrase` → exit 2, the existing piped-stdin message. `--ttl` above 1d → exit 2. `gen` is unchanged.
- stdout carries only the link. The stderr hint adds "File: `<name>` (`<size>`). Files last at most 1 day." and never the link or key.
- `get` on a file link decides where the file goes **before** the reveal request:
  - `-o PATH` given:
    - PATH is an existing directory: write `<dir>/<safe name>`.
    - Otherwise PATH is the target file. Its parent must be an existing directory and PATH must not exist; if it exists → exit 2 "<PATH> already exists; nothing was opened."
  - No `-o`, stdout not a TTY: raw bytes to stdout, nothing else on stdout.
  - No `-o`, stdout a TTY: exit 2 "This link holds a file. Save it with -o <file or directory>, or redirect the output." Nothing is opened.
- Writing: `Io.writeFileExclusive(path, bytes)` opens with `O_CREAT | O_EXCL | O_WRONLY`, mode `0600`. That never overwrites and never follows a symlink at the final component. Into a directory: if `<name>` exists, try `<stem> (1)<ext>` … `(99)`, then `onetime-<8 hex>.bin`. Before opening, the core checks `dirname(resolve(target)) === resolve(dir)`, which is defence in depth (the safe name has no separators). If the write fails after the reveal, the partial file is removed and the command exits 5 with "Could not write the file. It is now used up."
- After saving, stderr shows "Saved `<safe name>` (`<size>`) to `<path>`." plus the risky-file warning when it applies.
- `get -o PATH` on a text link writes the text (UTF-8, no added newline) with the same exclusive rules. `status` on a file link says "The file is still waiting." (with "it needs a passphrase" for `2fp`).
- Exit codes unchanged: 0, 1 gone, 2 usage (including target exists and file-to-TTY), 3 damaged link, 4 decrypt, 5 network, server or write error after the burn, 70 internal.
- `Io` gains `stat(path): Promise<"dir" | "file" | "missing">`, `writeFileExclusive(path, bytes): Promise<void>` (rejects with `code: "EEXIST"`), `removeFile(path)` and `stdout.writeBytes(bytes)`. The reveal read cap becomes `MAX_BLOB_BYTES`.
- Deploy F1 ships `get`/`status` for files; `send --file` is behind `WRITE_FILES` (like `WRITE_FORMAT`): before F2 it exits 2 with "Sending files is not available yet."

### A-10. Self-hosting

- New settings in `server/config.ts`:
  - `ONETIME_MAX_STORED_BYTES`: default 400,000,000; range 1,000,000 to 1,000,000,000,000.
  - `ONETIME_MAX_LARGE_BYTES`: default 200,000,000; range 0 to the stored-bytes value. `0` turns large blobs off: bodies over 16,418 bytes get 413, so files up to 16,000 bytes still work.
  - `ONETIME_MAX_UPLOADS`: default 16; range 1 to 1,000. This many `POST /api/secrets` requests run at once; more get an immediate 503 with `Retry-After: 5`, after the bounded drain.
- `createApp` gets `maxBlobBytes` (derived as in A-5) for `boundedBody` (`limit = maxBlobBytes + 1`). `DRAIN_BYTES` (2 MiB) and `DRAIN_MS` stay. `requestTimeout` goes from 15 s to 60 s, so a 1 MiB upload works at about 150 kbit/s; `ONETIME_MAX_UPLOADS` bounds what slow uploads can hold.
- Memory: the router holds a body twice (chunks, then the joined copy) and node:sqlite copies it once more. Upload memory is therefore about `ONETIME_MAX_UPLOADS × 3 MB` (48 MB by default). Reveal memory is bounded by the large budget, because only that many large rows exist (worst case about 2 × 200 MB with every large row revealed at once). `docs/self-hosting.md` states both and advises a lower `ONETIME_MAX_LARGE_BYTES` on small VMs. SQLite stores up to 1 GB per BLOB by default (`SQLITE_MAX_LENGTH`), far above 1 MiB.
- Proxies: `client_max_body_size 1100k` and `client_body_timeout 60s` in `deploy/nginx.conf.example`; `max_size 1100KB` in `deploy/Caddyfile.example`. The same change goes into the `infra/deploy` branch's nginx template and Helm ingress annotations; ingress-nginx's default `proxy-body-size` of 1m (1,048,576) is below the 1,048,994-byte maximum blob, from ingress-nginx's docs, not checked here. The proxy must not log or buffer bodies to disk persistently.
- Abuse on an instance is the operator's responsibility; the guide says so (A-11).

### A-11. Abuse, legal and texts

What remains exploitable, stated plainly in the docs and SECURITY.md:
- **Storage filling**: 200 one-day uploads of 1 MiB fill the large budget and block files for everyone, for up to a day per round. Texts stay available (byte reserve). The 20,000-row and 400 MB caps can still be filled as today. Only a rate limit fixes this.
- **Daily D1 quota**: about 100,000 rows written per day for the whole site. Every create and reveal writes the row, its index entry and (unverified whether it counts) the stats row. Files do not change this, but an attacker who exhausts it stops every create and reveal until 00:00 UTC.
- **Anonymous encrypted hosting**: anyone can upload malware or illegal content for up to a day. The operator (Michal Maxian, named on the privacy page) cannot see it, cannot scan it and cannot identify the uploader (no IPs, no logs). Burn-once makes it a poor distribution channel (one download per link), but it works for targeted delivery, such as a payload to one phishing victim, and the site's name may lend credibility. Encrypted copies of opened or deleted blobs stay in D1 Time Travel for 7 days.
- **Legal**: running a public upload service in the EU likely brings hosting-provider duties, for example a notice-and-action mechanism under the Digital Services Act. That is **not verified legal advice**; the owner should confirm with counsel before deploy F2 (owner decision 8).

What the operator can do with a reported link: delete it if not yet opened, **without the key and without seeing the content**. `node tools/burn-id.mjs <origin> <id-or-link>` checks the id against `ID_PATTERN`, drops anything after the id (the key never leaves the script's memory and is never printed), sends `POST /api/secrets/<id>/reveal`, discards the body and prints `deleted` (200) or `not stored` (404). It works for the hosted site and any self-hosted instance. The operator never opens a reported link with its key, because possessing some content is itself illegal. Hosted fallback: `wrangler d1 execute onetime --remote --command "DELETE FROM secrets WHERE id = '<validated id>'"`.

Texts (all three outputs: app `dist/`, info `dist-info/`, self-host `dist-selfhost/`; every FAQ change also in its FAQPage JSON-LD; `sitemap.xml` `lastmod`):
- `index.html`: the create view switch and labels (A-7); the summary list item "Share a password, token or small file (up to 1 MB) …"; footer link "Report abuse" (to the privacy page's `#abuse`). Title and description reviewed by `seo-expert`.
- `how-it-works.html`:
  - Journey step 1: a file's name and type are encrypted together with its contents.
  - Stored / never stored: the stored size shows which size class the file is in (up to 1 KB, 4 KB, 16 KB, 64 KB, 128 KB, 256 KB, 512 KB or 1 MB), and the database can tell a file from a text; name, type and content are never stored readable.
  - Link anatomy: `2f`.
  - Limits section: files are not scanned; save once, then the copy on the server is gone; if the download breaks after Reveal, the file is lost.
  - New FAQ "Can I send a file?": up to 1 MB, at most 1 day, downloaded once, not scanned, warning for program files.
  - FAQ "How large can a secret be?": add files.
  - Self-host profile: "up to 1 MB, or less if the operator set a lower limit".
- `command-line.html`, `README.md`: `send --file`, `--name`, `get -o`, the redirect rule, exit codes, "File links need version 0.3.0 or newer; older versions report them as damaged without using them up." README "Limits": the byte caps, the 1-day rule for blobs over 16 KB, and the file budget that an attacker can fill.
- `privacy.html` (both profiles):
  - "What is stored" adds encrypted files: name and type encrypted, size class visible.
  - New section `#abuse` "Reporting abuse": write to the contact; send the link **without the part after the last dot** (the key), or only the id; what we do (delete it if it is still stored, without opening it); what we cannot do (see contents, identify the sender, recover an opened or expired file); Cloudflare's 7-day encrypted recovery history.
  - Self-host profile: the same, with `{{OPERATOR_CONTACT}}`.
- `SECURITY.md`: an "Abuse is not a vulnerability" paragraph pointing to the privacy page's `#abuse`; in scope: file name sanitisation, download handling, anything that renders a file on the app origin; out of scope: the file budget being fillable (known, like the 20,000 cap).
- `docs/self-hosting.md`: the three settings, memory, proxy body size, files off (`ONETIME_MAX_LARGE_BYTES=0`), handling abuse reports with `burn-id.mjs`, the operator's legal responsibility.
- `CLAUDE.md` (owner's file; the main session applies the exact lines): rules (file links, `download.ts` only, no previews, CSP unchanged), limits, `0003_bytes.sql`, abuse procedure.

## Rollout (hosted)

1. **A0 spike** (needs the owner's approval to create resources): a throwaway Pages project `onetimepass-spike` with its own D1 database `onetime-spike` (Free allows 10 databases), deploying a branch with the A5/A6 router and store. Measure: 50 sequential and 20 parallel create+reveal cycles at 1 MiB, 512 KiB and 256 KiB. Pass = no `1102`/exceeded-CPU or memory errors and every reveal byte-identical, with Pages Functions CPU time from the dashboard metrics. Also: database size before and after uploading and deleting 300 MB (does Time Travel count?). Then delete the project and the database. The result fixes `MAX_FILE_BYTES` (1 MiB → 256 KiB → 16,000 B fallback). Record it in this file under "Deviations".
2. **Remote migration** `0003_bytes.sql` (owner approval). It is safe with the code that is running: the old insert ignores `bytes`, and the triggers keep it exact.
3. **Deploy F1, readers** (info site first, then the app, as now): the router with byte caps and the 1-day large rule, the store SQL, web and CLI 0.3.0 that read `2f`/`2fp`, `WRITE_FILES = false`. It can be combined with blob-v2 deploy 2 if that has not shipped yet. Check on production with a throwaway script that uploads a file blob (`encryptFile` with `writeFiles` on) and opens it in the web page and the deployed CLI; curl a 1,048,995-byte body → 413.
4. **Deploy F2, writers**: file UI, `send --file`, all texts, `burn-id.mjs`. Info site first (the abuse section must exist before the footer links to it).
5. Rollback F2 → F1 is safe. Never roll back below F1 while file links can be unexpired (1 day after the last F2 deployment); older deployments would show them as incomplete, still without burning them.

Self-hosted: one update applies `0003` at start (`user_version`); `docs/self-hosting.md` "Updating" says to update the server and the proxy body size together.

## Task list (phase A; branch `feat/files` in `/home/claude/onetime-files`, after `sec/blob-v2` is merged; sequential, `code-reviewer` before the merge)

| # | Agent | Red test first | Then |
|---|---|---|---|
| A0 | `developer` + main session (resources) | spike script `~/.tmp/...` (not in repo) | owner approval; result into "Deviations" |
| A1 | `developer` | `test/node/filename.test.ts`: the hostile-name table below, `riskyFile`, `cleanMime`, `formatBytes` | `src/web/filename.ts` |
| A2 | `developer` | `test/node/padding.test.ts`: file buckets, boundaries 636/637, 3,708/3,709, 16,000/16,001, 65,536 + 388 meta, 1 MiB max, nonzero padding | `padding.ts` generalised; `limits.ts` constants; a test that `MAX_BLOB_BYTES === fileBlobBytes(1 MiB) === 1,048,994` |
| A3 | `developer` | `test/node/file-payload.test.ts`: encode/decode; N = 0, T = 128, overruns, empty content, invalid UTF-8 name → throw | `src/web/file-payload.ts` |
| A4 | `developer` | `test/web.test.ts` (link): `2f`, `2fp` round trip; `2pf`, `2F`, `f2`, `2ff`, four segments → invalid; blob-v2's old pattern rejects `2f` (fixture of the 0.2.0 regex) | `link.ts`, `FORMAT_PATTERN` |
| A5 | `developer` | `test/node/crypto-files.test.ts`: an independent `node:crypto` implementation builds and opens file blobs with and without passphrase (real 600,000); flags byte 0x02 under a `2.` link, 0x00 under `2f.`, flipped bit, wrong bucket size → throw | `crypto.ts`: `encryptFile`, `openPayload` (text \| file), `LinkKey.file`, `WRITE_FILES = false` |
| A6 | `developer` | `test/contract/api-contract.ts` (both stores): `maxStoredBytes`/`maxLargeBytes` small values; large 7-day → 409 `maxTtl`; large refused at the large cap while small still fits; long TTL at 80 % of bytes → 409; 1,048,994 → 201, 1,048,995 → 413; `maxLargeBytes: 0` → 16,419 → 413; counter equals `COUNT(*)` and `SUM(length(blob))` after 30 concurrent mixed creates, reveals and purges; structural single-statement check still holds; migration test from a 0002 database with rows gives exact `bytes` | `migrations/0003_bytes.sql`, `store.ts`, `store-d1.ts`, `server/store-sqlite.ts`, `src/worker/index.ts` |
| A7 | `developer` | `test/node/config.test.ts`, `http.test.ts`, `bounded-body.test.ts`: three settings, range errors, 413 + drain at the configured limit, 17th concurrent upload → 503, 1 MiB round trip through the Node server | `server/config.ts`, `http.ts`, `main.ts`/`start.ts` wiring |
| A8 | `developer` | `test/cli-core.test.ts`, `test/cli-interop.test.ts`: file link on TTY without `-o` → exit 2 **with no POST seen**; existing target → exit 2, no POST; directory target with collision → `(1)`; symlink at the target → refused (Node test with a real temp dir in `test/node/cli-main.test.ts`); hostile name → saved under the safe name inside the dir; stdout raw bytes when piped; write failure → exit 5 and partial removed; `send --file` limits, `--file -` with TTY, with `--passphrase`; `--ttl 7d`; `WRITE_FILES` gate; CLI 0.2.0 fixture refuses `2f` | `cli/core.ts`, `cli/main.ts`, version 0.3.0 |
| A9 | `frontend-dev` | `test/open-flow.test.ts`: file outcome, failure after burn → "lost" outcome; DOM-free `src/web/file-flow.ts` (size precheck, ttl options for files, error mapping) tests; `test/node/no-object-url.test.ts`: `createObjectURL` and `revokeObjectURL` appear only in `src/web/download.ts`, and no `src/web` file assigns `innerHTML` | `api.ts` (signal, progress, `maxBytes`), `download.ts`, `main.ts`, `index.html` structure. Deploy F1 needs only the open/save path |
| A10 | `developer` | `test/node/check-dist.test.ts`: app `_headers` CSP unchanged (no `blob:`/`data:`) | `tools/check-dist.mjs` rule |
| A11 | `developer` | `test/node/burn-id.test.ts` against the Node server: link input → only the id sent, key never printed, 200 → `deleted`, 404 → `not stored`, bad id → exit 2 | `tools/burn-id.mjs` |
| A12 | `tester-ui` + `frontend-dev` | `test/e2e/files.spec.ts` (Playwright library, Chromium, Firefox, WebKit, against `dist-server/server.mjs` on a free port; script `pnpm e2e`, not part of `pnpm check` until CI exists) | proves A-8: download event fires with the safe name, page URL unchanged, no new page; an `.html` and an `.svg` file containing script → downloaded, `page.on("dialog")` never fires, no console CSP violation; risky warning shown; `2f` opened in today's v1 build and in a blob-v2 build → "incomplete", row still there; second reveal → gone; cancel upload |
| A13 | `web-designer` (`ui-designer` for the file mode visuals) | `pnpm check` (JSON-LD = FAQ, both profiles) | the texts in A-11; `seo-expert` reviews titles and descriptions |
| A14 | `developer` | `pnpm check` | `deploy/nginx.conf.example`, `deploy/Caddyfile.example`, `docs/self-hosting.md`; hand the same proxy change to the `infra/deploy` owner |

Deploy F1 = A1-A12 with `WRITE_FILES = false`; deploy F2 = flip plus A13, A14.

Hostile names (input → `safeFileName`): `../../etc/passwd` → `passwd`; `..\..\Windows\x.dll` → `x.dll`; `C:evil.txt` → `C_evil.txt`; `a\u0000b.txt` → `ab.txt`; `invoice‮txt.exe` → `invoicetxt.exe` (risky); `CON` → `_CON`; `con.txt` → `_con.txt`; `LPT9.log` → `_LPT9.log`; `COM¹` → `_COM¹`; `  .bashrc ` → `bashrc`; `file.txt.` → `file.txt`; `a<b>:"c|d?e*.txt` → `a_b___c_d_e_.txt`; `é.txt` → `é.txt`; `a\nb` → `ab`; `​`, `...`, `/`, `` → `onetime-file.bin`; `"a" × 300 + ".pdf"` → 200 bytes ending `.pdf`; `"é" × 150` → at most 200 bytes, valid UTF-8; `report.pdf.exe` → unchanged, risky.

## Phase B outline (large files; separate ADR, after rate limiting)

- **Storage**: an R2 bucket bound to the Function. D1 keeps the row (`id`, `expires_at`, `r2_key`, `size`), so the burn is still one D1 statement (`DELETE ... RETURNING r2_key`). The object is then streamed from R2 and deleted. Lifecycle rule 1 day as a safety net (R2 removes "within 24 hours"), plus an orphan sweep on requests (Free allows 50 subrequests per request, which caps per-request R2 deletes).
- **Encryption**: chunked AES-256-GCM (64 KiB chunks), nonce = 7-byte random prefix ‖ uint32 counter ‖ final-chunk byte, the header in the AAD of every chunk (STREAM construction), so truncation and reordering fail. Padding to coarse buckets or none (open). Browser decrypts chunk by chunk.
- **Open decisions**:
  1. Saving without holding the whole file in memory: File System Access API (Chromium only), a service worker download (needs `worker-src 'self'` and a new attack surface), or Blob parts in memory up to a few hundred MB.
  2. Burn semantics for interrupted downloads: claim-then-delete with a short grace period and a claim token returned to the first claimant (still one statement for the claim), or keep strict one-shot.
  3. Upload path: through the Function (100 MB body limit on Free, CPU per request) or presigned R2 multipart URLs (a new origin in `connect-src`, CORS on the bucket).
  4. Plan: R2 free 10 GB-month and 1 million Class A operations per month are reached quickly without a rate limit; whether a paid plan is acceptable.
  5. Whether D1 Time Travel-like retention applies to R2 (it does not keep deleted objects, but versioning must stay off) and what the texts say.
  6. Abuse handling at a scale where one-day public hosting of 100 MB files is attractive.
- **Prerequisites**: custom domain + WAF rate rule (item 7), phase A in production for some weeks with abuse reports reviewed, owner's plan decision.

## Risks

- **Free-plan CPU and memory (main risk)**: `Array.from` on a 1 MiB BLOB in both directions, and concurrent requests sharing 128 MB per isolate. If an isolate is killed after the `DELETE ... RETURNING`, that file is lost. Mitigation: spike A0, lower `MAX_FILE_BYTES`, and the large budget bounds how many such rows exist.
- **Fillable file budget** with about 200 requests; files then show 503 until rows expire. Accepted until rate limiting.
- **Legal exposure** of the named operator (A-11); owner decision 8 before F2.
- Browsers that ignore `download` on `blob:` URLs: the forced octet-stream and the inherited CSP keep this to a download prompt or a blocked save, never rendering. The e2e tests cover the three engines; old mobile browsers are not tested.
- Lost file when the connection drops after Reveal: inherent in one-shot; stated in the UI and on how-it-works.
- File overlap: `main.ts`, `index.html`, `cli/core.ts`, `crypto.ts`, `limits.ts` with `sec/blob-v2` (another agent is editing its web UI now): start only after it is merged. `deploy/` proxy files overlap with `infra/deploy`: change them after that branch merges, or hand the edit to its owner.
- The migration's correctness relies on D1 running statements one after another (single writer). The final `UPDATE` makes it exact even if the file is not one transaction; the contract migration test covers SQLite.

## Owner decisions (defaults let work proceed)

1. Phase A (files in D1, 1 MiB) now; phase B (R2) only after rate limiting. **Default: yes.**
2. Hosted maximum file size: 1 MiB if spike A0 passes, else 256 KiB, else 16,000 bytes. **Default: as measured.** Approve creating and deleting the spike project and database.
3. Byte caps: 400 MB total, files over 16 KB only while the total is under 200 MB. **Default: yes.**
4. Files last 1 hour or 1 day, default 1 day. **Default: yes.**
5. Accept that the database can tell a file from a text (flags byte, size class); name, type and content are hidden. **Default: accept.**
6. No preview of any file in the browser, ever; download only. **Default: yes.**
7. CLI `get` of a file without `-o` on a terminal refuses before opening (instead of saving into the current directory). **Default: refuse.**
8. Abuse policy: contact `michal@maxian.sk`; delete reported links by id without opening them; ask reporters to remove the key; check hosting-provider obligations (EU DSA) with counsel before deploy F2. **Default: yes, with that check.**
9. "Report abuse" link in the app footer, pointing to the privacy page. **Default: yes.**
10. Store the MIME type (display only). **Default: yes.**
11. Add the Playwright e2e suite to the repo (`pnpm e2e`), outside `pnpm check` until CI. **Default: yes.**

## Deviations

### A0 spike result (measured 2026-11-20): hosted `MAX_FILE_BYTES` = 128 KiB

- **Method.** The main session ran a Node script against a throwaway Pages project with its own D1 database on the free plan (both deleted afterwards). It made create+reveal cycles of random opaque blobs (10 and 50 sequential, 10 to 60 parallel) and a burn test: create N blobs, reveal all in parallel, and for each failed reveal check whether the row survived.
- **Results by blob size.**
  - 16,418 B and 64 KiB: 0 errors (up to 40 parallel).
  - 128 KiB: 0 errors in about 330 cycles, including 60 parallel creates and 40 + 160 burn reveals.
  - 256 KiB: some creates and 1 of 59 burn reveals failed with Cloudflare error 1102 (Worker exceeded resource limits). The failed reveal **lost the blob**: the row was deleted and the status was 404 afterwards.
  - 512 KiB: 10 of 28 reveals lost. 1 MiB: 3 of 22 lost, and many creates failed with 1102 under parallel load.
- **Conclusion.** The free plan's per-request CPU limit makes large blobs unsafe: a reveal killed after `DELETE ... RETURNING` loses the file. The hosted limit is `MAX_FILE_BYTES` = 128 KiB (131,072), which is the 131,460-byte bucket boundary (128 KiB + 388 of meta); the blob is 131,490 bytes. This is below the plan's 256 KiB fallback, which failed.
- **Counters.** The `stats` counters (`stored`, `bytes`) stayed exactly equal to `COUNT(*)` and `SUM(length(blob))` through all the 1102 failures.
- **Database size.** The database `file_size` did not grow after 20 MB were created and revealed (deleted pages are reused; Time Travel history is not counted in `file_size`, as far as this test shows).
- **Residual risk.** At 128 KiB a reveal can still in principle be killed under heavier load than measured; the UI's "lost after burn" message covers it.

### Limits after the spike: writers and routers at 128 KiB, readers at the format maximum

- `MAX_FILE_BYTES` = 131,072 and `MAX_BLOB_BYTES` = `fileBlobBytes(MAX_FILE_BYTES)` = 131,490 (a test pins both). They apply to the web writer, the CLI writer (`send --file`), the router and the Node server (its `boundedBody` default), hosted and self-hosted alike.
- New `FORMAT_MAX_FILE_BYTES` (1 MiB) and `FORMAT_MAX_BLOB_BYTES` (1,048,994): readers use these (`decodeFilePayload`, the unpad cap in `crypto.ts`, the web reveal `maxBytes`, the CLI reveal cap). The blob format and the bucket table are unchanged.
- **Why not a self-host setting for up to 1 MiB.** The web page and the CLI are one build for every instance and refuse content above `MAX_FILE_BYTES` before encrypting, so a server allowing more would store nothing larger anyway; a writer with a higher limit (a fork, a third-party client) would be the only source of such blobs. Keeping readers lenient means a blob up to the format maximum is opened by every client, so no instance and no later version can produce a link another client cannot open. The earlier plan idea of readers rejecting content above `MAX_FILE_BYTES` is dropped for that reason; writers stay strict.
- The A-10 proxy numbers (`client_max_body_size 1100k`, `max_size 1100KB`, body timeout 60 s) are replaced by 140k / 140KiB (143,360 bytes, minimum 131,490) and `client_body_timeout 30s`. The Helm `ingress.maxBodyBytes`, Ansible `onetime_max_body_bytes` and Terraform `max_body_bytes` defaults go from 65,536 to 143,360. ingress-nginx's default `proxy-body-size` of 1m is above the new maximum blob, so only a lowered value can hurt.
