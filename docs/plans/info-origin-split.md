# ADR: info pages on their own origin (security plan item 8)

Status: accepted by the owner on 2026-11-20 (separate Pages project, no custom domain). Not implemented yet.
Supersedes: the "Recommended" bullet of item 8 in `docs/plans/security-hardening.md`. Item 7 (custom domain, WAF) is dropped for now, see `docs/plans/near-full-ttl.md`.

## Recommendation

Two Cloudflare Pages projects built from one repo:

| Origin | Pages project | Serves | Analytics |
|---|---|---|---|
| `https://onetimepass.pages.dev` (app) | `onetimepass` (Functions + D1, as now) | `/`, `/command-line`, `/404`, `/cli/*`, `/api/*`, icons, manifest | none, on every path |
| `https://onetimepass-info.pages.dev` (info) | `onetimepass-info` (new: static only, no Functions, no D1) | `/how-it-works`, `/privacy`, `/404` | GA4 after Accept, as now |

The app origin ends with one strict CSP on every path and no Google host or string in any file. Self-host stays single-origin with all five pages and no analytics.

## Context

- Today GA runs on `/how-it-works`, `/command-line` and `/privacy` of the app origin (path-scoped CSP in `public/_headers`, `! Content-Security-Policy` detach). A malicious or compromised gtag.js runs with the app's origin: it can read app `localStorage`, open `/` in a same-origin iframe or window, and read the fragment `#<id>.<key>` of anything opened there (finding 3 of the 2026-11-20 audit).
- `pages.dev` is on the Public Suffix List: `https://publicsuffix.org/list/public_suffix_list.dat`, private-domains section, block `// Cloudflare, Inc. : https://www.cloudflare.com/`, line `pages.dev` (checked 2026-11-20; `workers.dev` is listed in the same block). So `onetimepass.pages.dev` and `onetimepass-info.pages.dev` are separate registrable domains: different origins **and** different sites.

## Decisions

1. **Page placement.** `/how-it-works` and `/privacy` move to the info origin. `/command-line` **stays on the app origin, without analytics**: its install commands (`curl ... | ...`, checksum line, PowerShell lines) are copied into terminals, so a tampered page means code execution on the user's machine. The CLI files `/cli/onetime.mjs`, `/cli/onetime.cmd`, `/cli/onetime.mjs.sha256` stay on the app origin for the same reason (and the CLI's default server is that origin anyway). The `cli_download` GA event goes away (owner decision 1).
2. **Old URLs on the app origin** redirect with `301` through a generated `dist/_redirects` (Pages runs redirects before assets and before headers):
   ```
   /how-it-works       https://onetimepass-info.pages.dev/how-it-works 301
   /how-it-works.html  https://onetimepass-info.pages.dev/how-it-works 301
   /how-it-works/      https://onetimepass-info.pages.dev/how-it-works 301
   /privacy            https://onetimepass-info.pages.dev/privacy 301
   /privacy.html       https://onetimepass-info.pages.dev/privacy 301
   /privacy/           https://onetimepass-info.pages.dev/privacy 301
   ```
   Browsers keep the fragment across a redirect whose `Location` has none, so `/privacy#cookies` still lands on the section. The app's `/` and `/index.html` **never** redirect (a secret fragment must not follow a redirect to another origin); `check-dist` enforces that no rule's source is `/` or `/index.html`.
3. **Info origin `_redirects`** (generated `dist-info/_redirects`), so stray links and old bookmarks reach the app:
   ```
   /                   https://onetimepass.pages.dev/ 301
   /index.html         https://onetimepass.pages.dev/ 301
   /command-line       https://onetimepass.pages.dev/command-line 301
   /command-line.html  https://onetimepass.pages.dev/command-line 301
   /cli/*              https://onetimepass.pages.dev/cli/:splat 301
   ```
4. **Links between the sites.** Source HTML keeps root-relative links (`href="/privacy"`). A new pure function `rewriteLinks(html, profile)` in `tools/site-profile-core.mjs` rewrites only `<a href>` values, by this fixed table, in the two Pages profiles; self-host is untouched:
   | Path (before `#`/`?`) | Home |
   |---|---|
   | `/`, `/command-line`, `/cli/` and below | app |
   | `/how-it-works`, `/privacy` | info |
   In the `onetimepass` (app) profile, info-home links become `https://onetimepass-info.pages.dev<path><#frag>`; in the `info` profile, app-home links become `https://onetimepass.pages.dev<path><#frag>`. Any other root-relative `<a href>` must point to a file in the same build (check-dist rule 4 below). Canonicals, `og:url`, `og:image`, `twitter:image` and JSON-LD URLs are written in the source with their final origin (info pages use `https://onetimepass-info.pages.dev`).
5. **Origin constants.** `tools/site-profile-core.mjs` gets `INFO_ORIGIN = "https://onetimepass-info.pages.dev"` next to `OWNER_ORIGIN`. The self-host `transformHtml` replaces both origins with `ONETIME_ORIGIN` (neither string is a substring of the other). `src/web/analytics-origin.ts`: `ANALYTICS_ORIGIN = "https://onetimepass-info.pages.dev"`. `src/web/analytics-config.ts` keeps `G-W3GR41J2NR` unless the owner has to create a new stream (owner action 2).
6. **Storage is per origin.** Theme (`localStorage.theme`) is chosen separately on each site; no syncing (it would need a URL parameter or cookie: not worth it). Consent (`onetime-consent`) exists only on the info origin; `CONSENT_VERSION` stays 1 (the info origin starts empty).
7. **Legacy cleanup on the app origin.** New `purgeLegacyAnalyticsState()` in `src/web/ga-cookies.ts`: delete `_ga*` cookies unconditionally and `localStorage.removeItem("onetime-consent")`. Called by `main.ts` and, in the app and self-host profiles, by `page.ts`. In the info profile `page.ts` (its 404) keeps today's consent-aware `clearLeftoverAnalyticsCookies()`. Selection by a Vite define `__SITE__` (`"app" | "info" | "selfhost"`), which replaces `__GA_ENABLED__` (`info.ts` uses `__SITE__ === "info"`). Remove the purge after 2027-12-31 (cookies lived at most 12 months; follow-up item).
8. **Footers.** App pages (`index.html`, `command-line.html`, app 404) show "Privacy" (cross-origin) and no "Cookie settings" (the app has nothing to consent to). Info pages keep "Cookie settings". The consent banner appears only on the info origin.
9. **Manifest.** Only the app has one. The info build deletes `manifest.webmanifest` and drops the `<link rel="manifest" ...>` line from its HTML (a PWA installed from the info origin would start on a redirect).
10. **SEO.** No hreflang (one language). App `sitemap.xml`: `/`, `/command-line`. Info `sitemap.xml`: `/how-it-works`, `/privacy`. Info `robots.txt`: `User-agent: *`, `Allow: /`, `Sitemap: https://onetimepass-info.pages.dev/sitemap.xml`. App `robots.txt` unchanged. Info pages keep the FAQPage block (must still equal the visible FAQ) and drop the `BreadcrumbList` (its first item would be another host). The 301s carry the old URLs' signals.

## Build

A third site profile, not a post-build split (chunks are hashed per build; splitting one `dist/` would need a dependency walk and would leave stray files).

| `ONETIME_SITE` | Inputs (`rollupOptions.input`) | Out dir | Extra outputs (closeBundle) |
|---|---|---|---|
| `onetimepass` (default, the app) | `index.html`, `command-line.html`, `404.html` | `dist/` | `_redirects` (decision 2), sitemap filtered to app URLs |
| `info` | `how-it-works.html`, `privacy.html`, `404.html` | `dist-info/` | `_redirects` (decision 3), `_headers` via `headersForInfo`, info robots, sitemap filtered to info URLs; deletes `_routes.json` and `manifest.webmanifest` |
| `selfhost` | all five | `dist-selfhost/` | as today; never writes `_redirects` |

- Inputs move from `vite.config.ts` into the plugin's `config()` (`inputsFor(profile)` in `site-profile.mjs`).
- HTML blocks: `applyBlocks` keeps `site:onetimepass` blocks for both Pages profiles (`info` is a Pages profile of the owner's site). No new marker name.
- `public/_headers` becomes the app file: the six info-path rules keep only `Cache-Control: no-store` (needed by self-host and the info build; on the app they are shadowed by the redirects), `/command-line(.html)` loses its CSP lines. Exactly one CSP line remains, in `/*`.
- `headersForInfo(text)` (pure, in `site-profile-core.mjs`): replace the `/*` CSP value with `INFO_CSP` (the current Google policy string from `public/_headers`, unchanged), drop the rules `/`, `/index.html`, `/command-line`, `/command-line.html`, `/cli/*`. Other `/*` headers (including whatever the Phase 1 headers branch adds) carry over unchanged.
- `public/sitemap.xml` lists all four URLs with their final origins; `sitemapForSite(text, origin)` keeps the `<url>` entries whose `<loc>` starts with that origin; self-host replaces both origins as today.
- `package.json` scripts:
  - `build`: `vite build && pnpm build:cli && pnpm build:info`
  - `build:info`: `ONETIME_SITE=info vite build`
  - `check`: after `node tools/check-dist.mjs`, add `node tools/check-dist.mjs dist-info --profile info`
  - `deploy`: `pnpm build && wrangler pages deploy` stays the app deploy; add `deploy:info` = `pnpm build && node tools/deploy-info.mjs` (below).

### check-dist (`tools/check-dist.mjs`)

Profile: `_selfhost.json` present = `selfhost`; else `--profile info` = `info`; else `app`. A wrong flag is caught by the content rules.

| # | app (`dist`) | info (`dist-info`) | selfhost |
|---|---|---|---|
| 1 | `_headers`: exactly one CSP line, in `/*`, equal to `STRICT`; no `!` line | exactly one CSP line, in `/*`, equal to `INFO_CSP`; no `!` line | as app |
| 2 | no file anywhere matches `/googletagmanager\|google-analytics\|analytics\.google\|gtag\|G-W3GR41J2NR/i` | `404.html` and every chunk it loads: same regex (kept) | as today |
| 3 | `index.html`, `command-line.html`, `404.html`, `cli/` present; `how-it-works.html`, `privacy.html` absent | `how-it-works.html`, `privacy.html`, `404.html` present; `index.html`, `command-line.html`, `cli/`, `_routes.json`, `manifest.webmanifest` absent | all five present; no `_redirects` |
| 4 | every root-relative `<a href>` path exists in this build (file, `<path>.html`, or `/`) | same | same |
| 5 | `_redirects` equals the decision-2 text; no source `/` or `/index.html` | `_redirects` equals the decision-3 text | n/a |
| 6 | no resource URL (`src`, non-`<a>` `href`, …) to the info origin | no resource URL to the app origin | no `onetimepass-info` anywhere, no `onetimepass.pages.dev` outside `cli/` |

The existing rules (inline script/style, handlers, external resources, JSON-LD, markers, placeholders, `unsafe-inline`) stay for all three. The `INFO_PATHS` CSP-detach rules are deleted.

## Deploy

- **Once (owner approved 2026-11-20):** `wrangler pages project create onetimepass-info --production-branch main`. CLAUDE.md records that a subagent was blocked from creating a Pages project before; run it in the main session if needed.
- **Info deploy** (`tools/deploy-info.mjs`, no Functions, no D1): `wrangler pages deploy` picks up `functions/` from its working directory and finds `wrangler.jsonc` by searching parent directories, so the script runs wrangler (absolute path `<repo>/node_modules/.bin/wrangler`) with `cwd` = a fresh empty directory under `~/.tmp/` (outside the repo):
  `wrangler pages deploy <repo>/dist-info --project-name onetimepass-info --branch main --commit-hash <sha> --commit-dirty=false`.
  The script refuses to run if `dist-info/` contains `_routes.json` or `index.html`, and removes its temporary directory afterwards.
- **App deploy:** unchanged (`wrangler pages deploy --project-name onetimepass ...` from the clean `git archive`, per CLAUDE.md).
- **Order, first time:** (1) create the project; (2) deploy info; curl `https://onetimepass-info.pages.dev/how-it-works` (200, CSP = `INFO_CSP`, `no-store`), `/` (301 to the app), `POST /api/secrets` (not 2xx, no JSON body: no Function); (3) owner updates the GA stream URL; (4) deploy the app; curl `/how-it-works` (301 to info), `/privacy#cookies` in a browser (lands on the section), `/` (CSP = `STRICT`), `/command-line` (CSP = `STRICT`), API round trip as in CLAUDE.md. Never deploy the app before the info site answers, or the 301s point at nothing.
- **Afterwards:** each release deploys info and app from the same commit, info first. Both need a green `pnpm check`. One approval per deploy (two deploys per release).
- **Rollback:** roll back the app deployment in Pages; the info project can stay (its pages just duplicate the old app pages until roll-forward).

## Texts that must change

- `privacy.html` (now on the info origin): a "Two sites" paragraph: `onetimepass.pages.dev` (secret page, command-line page, CLI downloads, API) runs no analytics, sets no cookies and loads nothing from other sites on any page; `onetimepass-info.pages.dev` (how it works, privacy) uses GA only after Accept. Analytics section: "runs only on the information site (how it works and this page)". Cookies section: the choice and the `_ga*` cookies apply to the information site only. Storage section: theme saved separately on each site. Add: GA cookies set on `onetimepass.pages.dev` before <switch date> are deleted by the app on the next visit. Description/OG texts: replace "information pages" with "information site".
- `how-it-works.html`: FAQ "Does the site use cookies or analytics?" and the footer text (same facts as above; keep the FAQPage JSON-LD equal); "see privacy" links get rewritten by decision 4.
- `index.html`, `command-line.html`, `404.html`: footer texts ("This page uses Google Analytics only if you accept" disappears from `command-line.html`); summary list item stays true.
- `README.md`: the paragraph "The information pages ... same origin as the app" becomes: info pages live on `https://onetimepass-info.pages.dev`, a separate site (separate entry on the Public Suffix List), and the app origin serves no Google code on any path. Layout table: `privacy.html`, `how-it-works.html` are built into `dist-info/`.
- `CLAUDE.md` (owner's file; hand the exact edits to the main session): Rules (`/` and `404.html` → "nothing on the app origin"); Pages and content (which page lives where, `_redirects`, extensionless URLs on two hosts, "Cookie settings in every footer" → info footers only); Analytics (only on `onetimepass-info.pages.dev`; `cli_download` removed; CSP is the info `/*` policy, not path-scoped; origin guard); check-dist description; Deployment (second project, info first, `deploy-info.mjs`, curl checks); "Every new HTML path" rule (now: say which profile builds it).
- `docs/self-hosting.md`: no change in behaviour; mention only if it names the info pages' analytics.

## Owner actions

1. GA Admin, data stream: change the stream URL to `https://onetimepass-info.pages.dev`. If the field cannot be edited, create a new web stream with that URL (same settings: Enhanced Measurement off) and send its measurement ID; `analytics-config.ts` then changes.
2. Approve the two first deploys (info, then app).
3. Do not enable Cloudflare Web Analytics on either project.
4. If Search Console is used: add `https://onetimepass-info.pages.dev/` and submit its sitemap.

## Task list (one branch `feat/info-origin`, after the Phase 1 headers branch is merged)

Agents: `developer` (tools, check-dist, scripts), `frontend-dev` (entries, `ga-cookies.ts`), `web-designer` (texts), `seo-expert` (review of SEO outputs), `code-reviewer` before the merge. They edit overlapping files, so in this order, not in parallel.

1. `test/node/site-profile.test.ts` (red first): `rewriteLinks` table cases (app and info profiles, fragments kept, self-host untouched, assets and `#` links untouched); `headersForInfo` (one CSP = `INFO_CSP`, removed rules, other `/*` lines kept); `sitemapForSite`; `inputsFor`; `transformHtml` self-host replaces `INFO_ORIGIN`. Then implement in `tools/site-profile-core.mjs`, `tools/site-profile.mjs` (+ `.d.mts`), `vite.config.ts`.
2. `test/node/check-dist.test.ts` (red first): fixture dirs per profile for rules 1-6, including "app `_redirects` with a `/` source fails", "info build with `_routes.json` fails", "app file containing `gtag` fails". Then `tools/check-dist.mjs`.
3. `test/consent.test.ts` / new unit test: `purgeLegacyAnalyticsState` deletes all `_ga*` deletion strings and the consent key (DOM-free part in `consent.ts` if needed). Then `src/web/ga-cookies.ts`, `main.ts`, `page.ts`, `info.ts`; delete `analytics-events.ts` and the click listener in `analytics.ts`; `analytics-origin.ts` constant.
4. `public/_headers`, `public/sitemap.xml`; `package.json` scripts; `tools/deploy-info.mjs`.
5. HTML sources: canonicals/OG/JSON-LD for info pages, footers, `command-line.html` uses `/src/web/page.ts`, manifest line.
6. Texts (privacy, how-it-works, README); `test/node/headers.test.ts` and `check-selfhost` expectations if they name the removed CSP rules.
7. `pnpm check` green; local probe: `wrangler pages dev dist` shows the 301s; serve `dist-info` with `wrangler pages dev dist-info` from an empty directory and check `/` redirects.

## Security argument: an attacker who controls gtag.js after the split

The script runs only on `onetimepass-info.pages.dev`, only for visitors who pressed Accept.

It **can**: change any info page (security claims on `/how-it-works`, the privacy text); replace links (e.g. "Share a secret" pointing to a look-alike origin; any external site can do the same); read and write info-origin `localStorage` and cookies; collect what GA already collects; navigate the visitor to `https://onetimepass.pages.dev/#<id>.<key>` of a secret the attacker created (the visitor would see attacker-chosen text after Reveal; any website can do this today); send blind cross-origin `POST /api/secrets/<id>/reveal` requests, which would burn a secret only if it knew an id (ids live only in fragments on the app origin).

It **cannot**: run script on the app origin (separate origin; app CSP `script-src 'self'` with no Google host on any path); read the app's DOM, fragments, `localStorage` or clipboard; frame the app (`frame-ancestors 'none'`, `X-Frame-Options: DENY`); script a window it opens on the app (app sends `Cross-Origin-Opener-Policy: same-origin`, which severs the opener link); read API responses (no `Access-Control-Allow-Origin` on API responses; creates need `Content-Type: application/octet-stream`, which triggers a CORS preflight the router does not grant); set or read cookies for the app via `Domain=pages.dev` (browsers refuse cookies on a public suffix); share a renderer process with the app in browsers with site isolation (different sites); tamper with the CLI or its install commands (decision 1).

Residual: tampered explanations on the info site, and phishing links from it. The `Referrer-Policy: no-referrer` on both origins means the info site does not learn which app page a visitor came from.

## Risks

- **File conflicts:** the Phase 1 headers branch edits `public/_headers`, `tools/check-dist.mjs`, `test/node/headers.test.ts`; the CI branch may edit `package.json`. Start this branch only after both are merged.
- `blob-v2.md` and `near-full-ttl.md` also edit `how-it-works.html`, `index.html`, `command-line.html`, `README.md`: run sequentially (suggested order: near-full TTL, this split, blob v2).
- Phase 1 item 5 (`security.txt`): `public/.well-known/` is copied into both builds; if it gets a `Canonical:` field, generate it per site.
- Old app deployments (`<hash>.onetimepass.pages.dev`) still contain the path-scoped Google CSP and the GA code (guarded off by the exact-origin check). Owner action 8 of the hardening plan (delete old deployments) covers them.
- Local `pnpm dev` links to the info pages go to production `onetimepass-info.pages.dev` (rewritten absolute links). Acceptable; noted in README "Commands".
- Wrangler's working-directory behaviour for `functions/` and config lookup is relied on by `deploy-info.mjs`; the post-deploy `POST /api/secrets` probe catches a regression.

## Owner decisions (defaults let work proceed)

1. `/command-line` on the app origin without analytics (loses its page views and the `cli_download` event). **Default: yes.** Alternative: on the info origin with GA; then a compromised gtag.js can rewrite install commands.
2. No "Cookie settings" link on app pages. **Default: yes.**
3. Redirect status 301 (permanent). **Default: 301.**
