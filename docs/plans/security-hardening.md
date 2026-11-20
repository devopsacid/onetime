# Security hardening plan

Source: security audit of `main` at `47bf8ac` (2026-11-20, code read, no penetration test).
Status: proposed. Nothing here is implemented yet. Items marked **owner** need a decision or a dashboard action first.

## Findings and fixes

| # | Finding | Severity | Fix | Phase |
|---|---|---|---|---|
| 1 | No rate limit; 20,000 creates fill the cap; `COUNT(*)` per insert burns D1 read quota | High | Counter row; custom domain + WAF rate rule; shorter TTL when nearly full | 1, 2 |
| 2 | Account takeover = malicious JS for everyone | High | 2FA, scoped token with expiry, delete old deployments | owner |
| 3 | Google script on the same origin as the secret app | Medium | Info pages on their own origin (or drop GA) | 2 |
| 4 | No CI, no dependency audit, no security contact, unsigned CLI | Medium | GitHub Actions gate, Dependabot, `SECURITY.md`, `security.txt`, attested releases | 1, 4 |
| 5 | An intercepted link is the whole secret | Medium | Optional passphrase (blob format v2) | 3 |
| 6 | D1 Time Travel keeps deleted blobs for days | Low | Exact wording on the pages; no technical fix on D1 | 1 |
| 7 | Hardening gaps (API headers, Permissions-Policy, no blob version, length leak, no connection limit) | Low | Headers, blob v2 with version byte and padding, `maxConnections` | 1, 3 |
| 8 | No browser e2e, bfcache unproven, CLI untested on Windows/macOS, no independent review | Assurance | Playwright e2e in the repo, OS matrix in CI, external review | 1, 3, owner |

## Phase 1: no owner decisions needed (one branch per item, `code-reviewer` before each merge)

1. **Counter row instead of `COUNT(*)`** (`developer`)
   - Plan facts (owner, 2026-11-20): the Cloudflare account is on the D1 **free plan**: 5 million rows read and 100,000 rows written per day. Past either, queries fail until 00:00 UTC, reveals included. The counter row removes the read amplification (a `COUNT(*)` per insert scans every row). The daily write quota stays an open denial-of-service path (each create and reveal writes rows); only a rate limit (custom domain + WAF) or a paid plan closes it. Time Travel on the free plan keeps 7 days, which the pages and README now state.
   - Near-full rule (implemented, `docs/plans/near-full-ttl.md`): above 80 % of the cap, links longer than 1 day are refused with 409 and `maxTtl`.
   - New migration `0002_counter.sql`: table `stats(id INTEGER PRIMARY KEY CHECK (id = 1), stored INTEGER NOT NULL)`, seeded from the current row count, kept exact by `AFTER INSERT` and `AFTER DELETE` triggers on `secrets`.
   - Insert becomes `INSERT ... SELECT ?1, ?2, ?3 WHERE (SELECT stored FROM stats WHERE id = 1) < ?4`. Still one statement, so the cap cannot overshoot. It counts stored rows (expired rows not yet purged included), which is stricter than today; the purge already runs before every insert.
   - Same SQL in `store-d1.ts` and `store-sqlite.ts`; the contract suite gets a test that the counter equals `COUNT(*)` after mixed concurrent create, reveal and purge.
   - Remote migration (`pnpm db:migrate:remote`) before the deploy that needs it: separate owner approval.
2. **Headers** (`developer`)
   - `API_HEADERS`: add `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `Strict-Transport-Security`, `Cross-Origin-Resource-Policy: same-origin`.
   - `public/_headers` `/*`: add `Permissions-Policy` (everything off; `clipboard-write=(self)`) and `Cross-Origin-Resource-Policy: same-origin`. Update `check-dist` and the self-host header tests.
3. **Node server connection limit** (`developer`): `server.maxConnections` with an env setting, documented in `docs/self-hosting.md`.
4. **CI** (`devops`): `.github/workflows/check.yml` running `pnpm check` and `pnpm audit --prod=false` on push and PR, actions pinned by commit SHA, least-privilege `permissions`, a CLI smoke job on Windows and macOS runners (closes that part of finding 8), `dependabot.yml` for npm, Actions and Docker digests.
5. **Security contact** (`web-designer` + `developer`): `SECURITY.md`, `public/.well-known/security.txt` (both site profiles; self-host uses the operator contact). Needs the contact address from the **owner**.
6. **Exact wording for deletion** (`web-designer`): state the D1 Time Travel window on `/how-it-works` and `/privacy` once the owner has confirmed the D1 plan (30 days on paid, 7 on free); mention the browser-history and history-sync exposure of an unopened link; in `docs/self-hosting.md` say that database backups keep burnt blobs.

## Phase 2: needs a custom domain (**owner**)

7. **Custom domain and rate limiting** (`architect` for the migration ADR, then `developer`, `frontend-dev`, `seo-expert`)
   - Owner adds a domain or subdomain as a Cloudflare zone and attaches it to the Pages project.
   - WAF rate limiting rule on `POST /api/secrets` (start: 10 per minute per IP, block 10 minutes). Cloudflare counts per IP inside its own edge; the project still stores no IPs. The privacy text must say this.
   - The `pages.dev` host bypasses the zone's WAF, so the Function must refuse creates on any host other than the custom domain. Reveal and status stay open on `pages.dev` for 7 days (the longest TTL), then the old host only redirects. The app page on `pages.dev` redirects to the new origin and keeps the fragment.
   - Move every origin constant: canonicals, sitemap, robots, OG tags, JSON-LD, CLI default server, the analytics origin guard, README, privacy page.
   - Optional: above 80 % of the cap, accept only TTLs up to one day.
8. **Analytics on its own origin** (`architect` ADR first)
   - Recommended: a second Pages project for the info pages on a separate subdomain, built by a third site profile (the profile tooling already exists). The app origin then has one strict CSP on every path and no Google host anywhere; `check-dist` enforces it.
   - Alternative, if the statistics are not worth it: remove GA, the banner and the path-scoped CSP entirely.

## Phase 3: blob format v2 and tests

9. **Blob format v2** (`architect` ADR, then `developer` + `frontend-dev`)
   - First byte = format version. v1 blobs (no version byte) stay readable until the longest TTL has passed.
   - Padding of the plaintext to fixed buckets so the stored length no longer reveals the secret's length.
   - Optional passphrase: PBKDF2-SHA-256 (600,000 iterations, random salt in the blob) combined with the link key through HKDF, so neither the link alone nor the passphrase alone decrypts. Web field plus hidden CLI prompt (never an argument).
   - Open design question for the ADR: a wrong passphrase is only detected after the reveal has deleted the blob. Either accept that a typo burns the secret, or put a short check value in the link fragment (catches typos, but weakens short passphrases against someone who holds the link). **Owner** decides.
   - The sender can already check whether a link was opened (`onetime status`, or opening their own link without pressing Reveal); add that hint to the "created" view.
10. **Browser e2e in the repo** (`tester-ui` + `frontend-dev`): Playwright suite for create, reveal, second open, damaged link, a real bfcache restore, "no request to any other origin from `/`", and the consent flow with Google hosts stubbed. Runs in CI.

## Phase 4: releases

11. **Attested CLI releases** (`devops`): tag-triggered workflow builds the CLI and attaches it to a GitHub release with a build-provenance attestation (keyless, no signing key to guard). README and `/command-line` document `gh attestation verify`. The same-site checksum stays as a download-damage check.

## Owner actions

1. Cloudflare dashboard: confirm the D1 plan (free or paid) and that Functions logs and Logpush are off.
2. Cloudflare and GitHub accounts: hardware-key 2FA; deploy token limited to this account's Pages and D1 with an expiry date.
3. Decide the custom domain and add it to Cloudflare (phase 2 cannot start without it).
4. Decide analytics: separate origin (recommended) or remove GA.
5. GitHub repository settings: branch protection on `main` with the CI check required, private vulnerability reporting, Dependabot alerts, secret scanning with push protection.
6. Give the security contact address for `SECURITY.md` and `security.txt`.
7. Decide the passphrase feature and the typo trade-off in item 9.
8. Approve deleting old Pages deployments after security fixes ship.
9. Decide whether to commission an independent review (the site must keep saying "not audited" until then).
10. Approve each remote D1 migration and each production deploy, as before.

## Not fixable by code

- Whoever serves the JavaScript can change it. Mitigations are account security (owner action 2), the CLI with attested releases, and self-hosting.
- D1 Time Travel cannot be turned off. The pages must describe it exactly.
