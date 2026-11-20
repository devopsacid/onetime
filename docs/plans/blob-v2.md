# ADR: blob format v2, length padding and optional passphrase (security plan items 5, 7, 9)

Status: accepted by the owner on 2026-11-20 (passphrase yes; a wrong passphrase burns the secret; no check value in the link). Not implemented yet.

## Recommendation

- The **link fragment** says which format the blob has; the blob also carries a version byte, bound into the AEAD as additional data. v1 links (`#<id>.<key>`) keep their exact meaning forever.
- v2 links: `#2.<id>.<key>` (no passphrase) and `#2p.<id>.<key>` (passphrase needed). Old web pages and old CLIs reject them as damaged **before** anything is revealed, so no live secret is ever burnt by a client that cannot read it.
- Plaintext is padded to four buckets (256 B, 1 KiB, 4 KiB, 16 KiB + 4) with a 4-byte length prefix.
- AES key = HKDF-SHA-256 of the link key; with a passphrase, HKDF over link key ‖ PBKDF2-SHA-256(passphrase, 600,000 iterations). The PBKDF2 salt is derived from the link key, so the slow step runs **before** the Reveal request.

## Context

- v1 (`src/web/crypto.ts`): blob = 12-byte random IV ‖ AES-256-GCM ciphertext ‖ 16-byte tag; the 32-byte link key is the AES key; no AAD; blob size = secret size + 28.
- A v1 blob's first byte is uniformly random, so **no leading byte value can tell v1 from v2**: any choice collides with 1/256 of v1 blobs. Size cannot tell them apart either (a v1 blob can have any v2 size). Only the link can carry the version without ambiguity.
- The server never sees the fragment; it treats the blob as opaque bytes and must keep doing so.
- Old CLI copies never update themselves (no update check, by design), so v1 links will keep being created by them indefinitely.
- workerd (the Workers runtime used by `vitest.config.ts`) rejects high PBKDF2 iteration counts ("Pbkdf2 failed: iteration counts above … are not supported", string present in the workerd 1.20261116.1 binary; Cloudflare's limit is 100,000). Browsers and Node have no such limit. Tests must account for this (see Tests).

## Decisions

### 1. Link grammar (`src/web/link.ts`, `src/shared/limits.ts`)

```
fragment-v1 = ID "." KEY                    ; exactly today's grammar
fragment-v2 = FORMAT "." ID "." KEY
FORMAT      = "2" / "2p"                    ; "p": a passphrase is needed
ID          = 22 base64url chars            ; ID_PATTERN, unchanged
KEY         = 43 base64url chars            ; KEY_PATTERN, unchanged (32 random bytes)
```

- New export `FORMAT_PATTERN = /^2p?$/` in `limits.ts`.
- `SecretLink` becomes `{ id: string; key: string; format: 1 | 2; passphrase: boolean }` (`passphrase` is always `false` for format 1).
- `buildLink(origin, link)`: format 1 → `${origin}/#${id}.${key}`; format 2 → `${origin}/#${link.passphrase ? "2p" : "2"}.${id}.${key}`.
- `parseFragment(hash)`: two segments → v1 (as today); three segments with a valid FORMAT first → v2; anything else → `"invalid"`.
- Why a prefix, not a suffix: a link cut off right after the key would turn `#<id>.<key>.2` into a valid-looking v1 link, and the client would burn the secret on a doomed v1 decrypt. With the prefix, any cut inside the key fails `KEY_PATTERN`, and the prefix itself cannot be cut without cutting everything after it.
- Old parsers (`parseFragment` today, CLI `parseLinkInput`) split on `.` and reject three segments as `"invalid"`: the old web shows "This link is incomplete" and the old CLI exits 3, both before any request that burns.

### 2. Blob v2 layout

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | version `0x02` |
| 1 | 1 | flags: `0x00` no passphrase, `0x01` passphrase; any other value is invalid |
| 2 | 12 | IV, random |
| 14 | bucket + 16 | AES-256-GCM ciphertext of the padded plaintext, then the 16-byte tag |

- AAD = bytes 0-1 (version and flags).
- Padded plaintext = `uint32 big-endian L` ‖ secret (L bytes of UTF-8) ‖ zero bytes, total length = the smallest bucket ≥ L + 4.
- Buckets `V2_BUCKETS = [256, 1024, 4096, MAX_SECRET_BYTES + 4]` → blob sizes 286, 1,054, 4,126 and 16,418 bytes. Every password, token or UUID the generator makes falls into the first bucket.
- The reader checks, before or after decryption as noted: blob length is one of the four sizes (before); byte 0 is `0x02` and byte 1 equals the link's passphrase flag (before); after decryption: `L ≤ bucket − 4`, `L ≤ MAX_SECRET_BYTES`, all padding bytes zero, UTF-8 valid (`fatal: true`). Any failure is reported exactly like a GCM failure.
- v1 blobs are read exactly as today, selected only by the v1 link grammar. v1 reading is kept indefinitely (owner decision 4).

### 3. Key derivation (WebCrypto only: browsers, Node 22+, workerd)

All HKDF calls: hash SHA-256, `salt` = empty (zero-length `ArrayBuffer`, which RFC 5869 treats as HashLen zero bytes), output 256 bits unless stated. Info strings are ASCII.

- `K_link` = the 32 bytes decoded from KEY.
- No passphrase: `K_aes = HKDF(ikm = K_link, info = "onetime v2 key")`.
- Passphrase:
  - `salt = HKDF(ikm = K_link, info = "onetime v2 pbkdf2 salt")`, 128 bits.
  - `P = PBKDF2-HMAC-SHA-256(password = UTF-8(normalize(passphrase)), salt, iterations = 600000)`, 256 bits.
  - `K_aes = HKDF(ikm = K_link ‖ P, info = "onetime v2 key+passphrase")`.
- `K_aes` is imported or derived as a non-extractable `AES-GCM` `CryptoKey`.
- Neither part alone decrypts: without `K_link` (256 random bits) there is no key; without the passphrase there is no `P`.
- What the passphrase does **not** do: someone who holds the link can press Reveal, get the blob, and then guess passphrases offline at 600,000 PBKDF2 iterations per guess. The recipient then finds the link used up and knows it was intercepted. The texts say this plainly.
- The salt is derived, not stored, so the recipient's page can run PBKDF2 (about a second, longer on old phones) before sending the Reveal request; closing the tab during the slow step loses nothing.
- 600,000 is the OWASP Password Storage Cheat Sheet figure for PBKDF2-HMAC-SHA256. It is fixed for format 2 (not stored in the blob); a change means format 3.

### 4. Passphrase rules (`src/web/passphrase.ts`, DOM-free)

- `normalizePassphrase(raw) = raw.normalize("NFKC").trim()`. NFKC rather than NFC so that full-width and other compatibility forms typed on different keyboards or IMEs match (NIST SP 800-63B asks verifiers to normalise memorised secrets with NFKC or NFKD). Trimming on both sides makes pasted leading or trailing whitespace harmless; inner spaces count.
- `validatePassphrase(raw)` on the normalised value: 8 to 256 code points (`[...s].length`); no C0, DEL or C1 control characters. Returns `null` or one of `"too-short" | "too-long" | "control"`.
- Recipients are held to the same rule: an entry that fails it cannot be right, so it is refused **before** Reveal ("A passphrase has 8 to 256 characters").
- Memory (best effort, stated as such): passphrase byte arrays are `fill(0)`-ed after `importKey`; keys are non-extractable; input fields are cleared after use and on `pagehide`. JavaScript strings cannot be wiped.

### 5. Writing format and rollout switch

`src/web/crypto.ts` exports `WRITE_FORMAT: 1 | 2`. Deploy 1 ships with `1` (readers only), deploy 2 flips it to `2` (owner decision 3). While `WRITE_FORMAT` is 1, the passphrase UI and CLI flags are hidden or refused ("not available yet"), because passphrase links are format 2 only.

### 6. Limits (`src/shared/limits.ts`)

- `MAX_SECRET_BYTES` stays 16,384 (the "16 KB" in every text stays true).
- `BLOB_OVERHEAD_BYTES` (28) is kept with its meaning "v1 overhead"; the router keeps refusing blobs `≤ 28` bytes with 400.
- `MAX_BLOB_BYTES = MAX_SECRET_BYTES + 4 + 14 + 16` = 16,418 (was 16,412). Comment: "largest v2 blob; also covers v1 (16,412)". The router's counted stream, the self-host 413 drain and the CLI's reveal read cap all use it, so they follow automatically. A test asserts it equals `14 + V2_BUCKETS.at(-1) + 16`.
- The server does not check v2 bucket sizes (it cannot tell formats apart, and old CLIs still upload v1).

### 7. Web UI (`index.html`, `src/web/main.ts`)

- Create view: a checkbox "Protect with a passphrase" reveals two `type="password"` fields ("Passphrase", "Repeat passphrase", `autocomplete="new-password"`) and the note: "Send the passphrase by a different channel than the link. The recipient gets one try: a wrong passphrase destroys the secret." Errors: too short/long, control characters, "The two passphrases differ."
- Created view, when a passphrase was used: "This link needs the passphrase. Send it separately, not in the same message." Also add the existing-capability hint from plan item 9: "You can check whether it was opened: open the link yourself without pressing Reveal."
- Open view for a `2p` link: heading "This secret is protected by a passphrase", one `type="password"` field (`autocomplete="off"`), warning: "You get one try. If the passphrase is wrong, the secret is destroyed and the sender has to send a new link." Reveal is enabled once the entry passes `validatePassphrase`. On click: derive `K_aes` (button text "Preparing…"), then `revealSecret`, then decrypt.
- Decrypt failure on a `2p` link: gone view "Wrong passphrase, or the link was changed", text "The secret has been deleted. Ask the sender for a new link." Non-passphrase failures keep today's text.
- `pagehide` also clears the three passphrase fields.

### 8. CLI (`cli/core.ts`, `cli/main.ts`)

- `send` and `gen`: `--passphrase` (no value: prompt twice on the terminal, "Passphrase (input hidden): " and "Repeat passphrase: ") or `--passphrase-file PATH` (first line; one trailing newline stripped; at most 4,096 bytes; strict UTF-8). Mutually exclusive. `gen --print-only` with either is a usage error. `send --passphrase` with piped stdin is a usage error ("use --passphrase-file when the secret is piped"), because the prompt reads the same stdin. Never accepted as an argument value: `--passphrase=x` is a usage error with the same wording as `SEND_ARG_ERROR`.
- `get` on a `2p` link: `--passphrase-file PATH`, else a hidden prompt when stdin is a TTY ("Passphrase (input hidden, one try): "), else exit 2 "This link needs a passphrase: run it in a terminal or use --passphrase-file." `--passphrase-file` on a link without passphrase: exit 2 "This link has no passphrase." Both checks, and `validatePassphrase`, happen **before** the reveal request.
- Wrong passphrase: exit 4, "Decryption failed: wrong passphrase, or the link was changed. The secret is now used up."
- `status` on a `2p` link: "The secret is still waiting (it needs a passphrase)."
- `send`/`gen` hints with a passphrase add: "Send the passphrase separately. A wrong one destroys the secret." (stderr; never the passphrase).
- `Io` gains `readFile(path: string, max: number): Promise<Uint8Array>` and a test-only `pbkdf2Iterations?: number` (never set by `main.ts`; a node test asserts that).
- `package.json` version 0.1.0 → 0.2.0 in deploy 1 (readers); help text and `--help` list the new options in deploy 2.

### 9. Crypto module API (`src/web/crypto.ts`)

```ts
export const WRITE_FORMAT: 1 | 2;
export interface LinkKey { key: string; format: 1 | 2; passphrase: boolean }
export function createCodec(opts?: { pbkdf2Iterations?: number; writeFormat?: 1 | 2 }): {
  encryptSecret(text: string, passphrase?: string): Promise<{ blob: Uint8Array<ArrayBuffer>; key: string; format: 1 | 2; passphrase: boolean }>;
  deriveKey(link: LinkKey, passphrase?: string): Promise<CryptoKey>;   // slow step, no network
  openBlob(blob: Uint8Array<ArrayBuffer>, aesKey: CryptoKey, link: LinkKey): Promise<string>;
  decryptSecret(blob: Uint8Array<ArrayBuffer>, link: LinkKey, passphrase?: string): Promise<string>;
};
export const { encryptSecret, deriveKey, openBlob, decryptSecret } = createCodec();   // 600,000, WRITE_FORMAT
```

For format 1, `deriveKey` imports `K_link` directly (today's behaviour) and `openBlob` reads the v1 layout. `SecretTooLargeError` unchanged. Padding lives in `src/web/padding.ts` (`pad(bytes): Uint8Array`, `unpad(inner): Uint8Array`, both pure, throwing on bad input).

## Interop matrix

Rows: who opens. Columns: which link. "Old" = today's code (CLI 0.1.0, or an un-reloaded tab / un-updated self-host instance).

| Opens ↓ / Link → | v1 (old CLI, today's web) | v2 `2.` | v2 `2p.` |
|---|---|---|---|
| old web | works | "This link is incomplete", nothing burnt | same |
| new web | works | works | asks passphrase, one try |
| old CLI 0.1.0 | works | exit 3 "damaged link", nothing burnt | same |
| new CLI 0.2.0 | works | works | prompt or `--passphrase-file` |

Writers: new web and new CLI write v2 after deploy 2; old CLI keeps writing v1 forever, which new readers accept. A new CLI pointed at an old self-host instance (`--server`) can upload v2 blobs; that instance's old web cannot open them (no burn), and its old router refuses blobs over 16,412 bytes (413) for secrets above 4,092 bytes (their padded blob is 16,418 bytes, the largest bucket). `docs/self-hosting.md` tells operators to update.

## Deploy order (never breaks a live link)

No D1 migration (the blob column is opaque).

1. **Deploy 1, readers:** web and CLI parse and decrypt v1 and v2, server accepts 16,418 bytes, `WRITE_FORMAT = 1`. Existing v1 links keep working; nothing writes v2 yet. Rollback is harmless.
2. Verify on production with a v2 link made locally against production (a throwaway script using `createCodec({ writeFormat: 2 })`) and opened in the web page and with the deployed CLI.
3. **Deploy 2, writers:** `WRITE_FORMAT = 2`, passphrase UI and CLI flags on, texts switched. Rollback to deploy 1 is still safe: deploy 1 reads every v2 link.
4. Never roll back past deploy 1 while v2 links may be unexpired (7 days after deploy 2): an older deployment would show them as incomplete (still not burnt).

## Texts that must change (in deploy 2)

- `how-it-works.html` (+ FAQPage JSON-LD wherever an FAQ answer changes):
  - Journey step 1: the secret is padded to one of four sizes, then encrypted with AES-256-GCM under a key derived (HKDF-SHA-256) from the random key in the link, and with a passphrase also from the passphrase (PBKDF2-SHA-256, 600,000 rounds).
  - "Only the encrypted data (IV, ciphertext and authentication tag)" → "(a format byte, a flag saying whether a passphrase is needed, the IV, the ciphertext and the authentication tag)".
  - Stored / never stored: stored size shows only which of four size classes (up to about 250 bytes, 1 KB, 4 KB, 16 KB) the secret is in; links from command-line versions before 0.2.0 still reveal the exact length. The passphrase is in the "never" list.
  - Link anatomy: example `https://onetimepass.pages.dev/#2.<id>.<key>`, three parts: format (`2`, or `2p` when a passphrase is needed), id, key.
  - Limits: "If someone gets the link": without a passphrase they can read the secret; with one they can still destroy it and then guess the passphrase offline, so use a long, unrelated passphrase and send it another way. Either way the recipient sees "no longer available" and knows.
  - New FAQ "What does the passphrase do?" (text from the paragraph above plus "a wrong passphrase destroys the secret; there is one try"). FAQ "What happens if the link is cut off or changed?": add the wrong-passphrase case.
- `index.html`: summary item 1 mentions the optional passphrase.
- `command-line.html` and `README.md`: `--passphrase`, `--passphrase-file`, the `get` prompt, exit 4 wording, "Links made since <deploy 2 date> need version 0.2.0 or newer; older versions report them as damaged without using them up." README "How it works" step 2 link format becomes `https://<host>/#2.<id>.<key>` (`2p` with a passphrase).
- CLI help (`HELP_MAIN`, `HELP_TOPICS`): new options; link shape "https://<host>/#2.<id>.<key>" in the damaged-link message.

## Task list (branch `feat/blob-v2`, after `feat/info-origin` is merged; `developer` for crypto/CLI, `frontend-dev` for the page, `web-designer` for texts, `code-reviewer` before each merge)

Deploy 1 commit set (TDD order):
1. `test/node/padding.test.ts`: bucket choice at L = 0, 252, 253, 1020, 1021, 4092, 4093, 16384; `unpad` rejects nonzero padding, L too large, wrong total size. → `src/web/padding.ts`.
2. `test/node/passphrase.test.ts`: NFKC (`"ｐａｓｓｗｏｒｄ１２"` equals `"password12"`), trim, 7/8/256/257 code points (astral characters count once), control characters. → `src/web/passphrase.ts`.
3. `test/web.test.ts` (link): v1 and both v2 forms round-trip; suffix forms, `3.`, `2P.`, four segments, short key → `"invalid"`. → `link.ts`, `FORMAT_PATTERN`.
4. `test/node/crypto-v2.test.ts` (Node, real 600,000): an **independent** v2 implementation in the test with `node:crypto` (`hkdfSync`, `pbkdf2Sync`, `createCipheriv("aes-256-gcm")` with `setAAD`) builds blobs that `decryptSecret` opens, and opens blobs that `encryptSecret` makes, with and without passphrase; flipped flag byte, flipped version byte, wrong passphrase, v2 blob under a v1 link and vice versa all throw; v1 fixture blobs from today's code still open. → `crypto.ts` (`createCodec`, `WRITE_FORMAT = 1`).
5. Workers-runtime tests (`test/web.test.ts`, `test/cli-interop.test.ts`): use `createCodec({ pbkdf2Iterations: 1000 })` / `Io.pbkdf2Iterations`; round trip through the real router at the 16,418-byte maximum; 16,419 → 413.
6. `limits.ts` (`MAX_BLOB_BYTES`), contract suite size cases updated; `test/node/bounded-body.test.ts` limits.
7. `cli/core.ts`, `cli/main.ts`: parse v2 links, decrypt both, `status` wording; tests in `test/cli-core.test.ts`: old-format link still works, `2p` link without TTY and without file exits 2 **with no reveal request made** (assert the fake fetch saw no POST), passphrase file rules. Version 0.2.0.
8. `main.ts` open path for v2 links (passphrase field, derive-then-reveal). `pnpm check`. Deploy 1.

Deploy 2 commit set:
9. `WRITE_FORMAT = 2`; create-side UI and CLI flags with their tests (prompt twice and mismatch, mutually exclusive flags, `--passphrase=x` refused, piped `send --passphrase` refused).
10. Texts listed above; `sitemap.xml` `lastmod` for changed pages. `pnpm check`. Deploy 2.
11. Throwaway Playwright run (until plan item 10 lands): create with and without passphrase, open with right and wrong passphrase, old v1 link from CLI 0.1.0 still opens.

## Risks

- PBKDF2 at 600,000 iterations can take several seconds on low-end phones; the "Preparing…" state must stay visible and the button disabled (WebCrypto calls are asynchronous; measure on a slow device emulation during step 11).
- A sender typo in the passphrase is caught by the repeat field; a recipient typo burns the secret by design (owner decision of 2026-11-20).
- workerd's iteration cap means the real 600,000 path is tested only in Node; the independent `node:crypto` test is what proves the format.
- File overlap with `info-origin-split.md` and `near-full-ttl.md` (`main.ts`, `cli/core.ts`, `index.html`, `how-it-works.html`, `README.md`): sequential branches only.

## Owner decisions (defaults let work proceed)

1. Passphrase length 8 to 256 characters after normalisation. **Default: yes.**
2. Buckets 256 B / 1 KiB / 4 KiB / 16 KiB. **Default: yes** (finer buckets leak more, coarser waste little: 20,000 × 16 KB is already the worst case).
3. Two deploys (readers, then writers). **Default: yes.**
4. Keep reading v1 links indefinitely, because old CLI copies keep making them. **Default: yes.** Alternative: drop v1 later; new readers would then refuse two-segment links before Reveal.
5. `--passphrase-file` for scripts (no environment variable, no argument). **Default: yes.**
