# ADR: aggregate usage counters on the app origin

Status: proposed 2026-11-24 (design only, nothing implemented). Owner decisions of 2026-11-24 are the input; the choices
marked **Decision** below are the architect's and need the owner's OK where the "Owner actions" list says so.

## Recommendation

- Count four things per UTC day, with no identifier of any kind: loads of the app page `/`, secrets created, secrets
  revealed, and reveals that found nothing ("gone"), the last three split by kind `text`, `text-pass`, `file`,
  `file-pass` (`unknown` when the client did not say).
- Store them in **Cloudflare Workers Analytics Engine** through a binding on the existing Pages Function. No D1 write,
  no new Function route, no new static path, no CSP change.
- The router gets an injected `Usage` sink (`count(event, label)`, no-op by default). Only the Pages Function wires it to
  Analytics Engine. Self-hosted servers keep the no-op and their texts stay "no analytics".
- The page load is counted on the request the page already makes on every load, `GET /api/limits`, with `?view=app`.
  That costs no extra Function request against the shared free quota of 100,000 per day.
- `/command-line` is **not** counted in this phase. See Decision 2.
- Viewing: a private `tools/stats.mjs` reads a token from the environment and queries the Analytics Engine SQL API. No
  public endpoint.

## Context

- The router `handle(request, store, ctx, options)` in `src/worker/index.ts` is runtime-neutral, and
  `test/runtime-neutral.test.ts` enforces that. `functions/api/[[path]].ts` is the only Cloudflare wiring.
  `public/_routes.json` limits the Function to `/api/*`.
- Every app page load already calls `fetchLimits()` (`src/web/main.ts`, `void fetchLimits().then(...)` at start-up),
  which is `GET /api/limits` (`src/web/api.ts`). The CLI calls the same endpoint only before `send --file`
  (`cli/core.ts`).
- The server cannot tell a file from a text by size: small files use the same buckets as texts (`FILE_BUCKETS` in
  `src/shared/limits.ts`). So the kind must come from the client. The link prefix (`2`, `2p`, `2f`, `2fp`, or none for
  v1) gives the kind on reveal; `parseFragment` in `src/web/link.ts` already returns `{ file, passphrase }`.
- Telling the server the kind gives it nothing new: README says "The blob shows its format, whether a passphrase is
  needed, whether it is a file". The flags byte of a v2 blob carries those bits.
- D1 writes are an open denial-of-service path on the free plan (CLAUDE.md "Known open points"), so counters must not
  touch D1.

### Cloudflare facts (checked against developers.cloudflare.com on 2026-11-24)

| Fact | Source page |
|---|---|
| Analytics Engine is one of the binding types for Pages Functions. It can be set in the Wrangler file or the dashboard. "You cannot use an Analytics Engine binding locally." | `/pages/functions/bindings/` |
| `analytics_engine_datasets` is a supported non-inheritable key in a Pages Wrangler config. `main` and similar Workers keys "do not apply". | `/pages/functions/wrangler-configuration/` |
| Syntax: `"analytics_engine_datasets": [{ "binding": "<BINDING>", "dataset": "<DATASET>" }]`. `dataset` is optional and defaults to the binding name. | `/workers/wrangler/configuration/` |
| "datasets are created automatically the first time you write to them" | `/analytics/analytics-engine/get-started/` |
| "You do not need to await `writeDataPoint()`": it returns immediately and the runtime writes in the background. | same |
| Workers Free: 100,000 data points written and 10,000 read queries included per day. "Currently, you will not be billed." The page does not say what happens past the free amounts. | `/analytics/analytics-engine/pricing/` |
| Retention: "stored for three months". Up to 20 blobs, 20 doubles and 1 index per data point; 250 data points per invocation. | `/analytics/analytics-engine/limits/` |
| SQL API: `POST https://api.cloudflare.com/client/v4/accounts/<account_id>/analytics_engine/sql`, query text as the body, `Authorization: Bearer <token>`. Permission "Account / Account Analytics / Read". Formats JSON (default), JSONEachRow, TabSeparated. | `/analytics/analytics-engine/sql-api/`, `.../sql-reference/statements/` |
| Rows can be sampled. Count with `SUM(_sample_interval)`, never `count()`. Sampling starts only when a single index value gets many writes. | `/analytics/analytics-engine/sql-api/`, `.../sampling/` |
| `toStartOfInterval(timestamp, INTERVAL '1' DAY)`, `formatDateTime(..., '%Y-%m-%d')`, `now()`, `INTERVAL '<n>' <unit>` | `.../sql-reference/date-time-functions/` |
| Pages Functions requests count toward the Workers Free quota of 100,000 per day. Static asset requests are free. The page does not say what happens past the limit. | `/pages/functions/pricing/` |

## Decisions

### 1. Events and labels (closed sets)

| event | label | written when |
|---|---|---|
| `view` | `app` | `GET /api/limits?view=app` answered 200 and `Sec-Fetch-Site: same-origin` (Decision 3) |
| `create` | kind | `POST /api/secrets` answered **201**. Refusals (400, 409, 413, 415, 500, 503) are not counted. |
| `reveal` | kind | `POST /api/secrets/<id>/reveal`: `store.take` returned a blob, so the row is gone. Counted even if the body does not reach the client afterwards, because the burn happened. |
| `gone` | kind | the same POST with a well-formed id where `store.take` returned null (already opened or expired; one statement cannot tell which, and adding a query to find out is not worth it) |

kind ∈ `text`, `text-pass`, `file`, `file-pass`, `unknown`. A v1 link (`#<id>.<key>`) is `text`.

Not counted: `GET /api/secrets/<id>` (status), 405 answers, malformed ids, `/api/limits` without `view`.

**Decision: count `gone` too.** It is cheap (one data point, same labels), it shows how often people open dead
links, and it can tell a broken client from real use. Expired and already-opened are not split, because that would need
a second statement next to the single atomic `DELETE ... RETURNING`.

### 2. `/command-line` is not counted (this phase)

- The page makes no API request today, so counting it would need a new Function request per load and a new endpoint
  that exists only to count. That request comes out of the same 100,000-per-day quota the API needs.
- The page is deliberately kept minimal: install commands are copied into shells, and CLAUDE.md gives it no analytics
  for that reason. A same-origin counter would not change what the page shows, but leaving the page alone keeps the
  rule simple: `page.ts` stays theme-only.
- If the owner wants it later, add `view=cli` to the same closed set and have `page.ts` send it on `command-line.html`
  only (a `data-usage-page` attribute, so the app's `404.html`, which uses the same entry, stays uncounted). No
  structural change is needed.

### 3. Page-load counting on `GET /api/limits?view=app`

- Wire form: `GET /api/limits?view=app`. The response is the same as today for every request (same body, `no-store`,
  same headers), so the limits contract does not change and old servers simply ignore the parameter.
- Count only when all of these hold: method GET, `view` is exactly `app` (anything else: not counted, still 200), and
  the request header `Sec-Fetch-Site` equals `same-origin`. Browsers send that header on `fetch`. It blocks the cheapest
  inflation: another site making its visitors' browsers request the URL (`<img>`, `no-cors` fetch). curl can fake
  the header; see Risks.
- **GET is acceptable here.** Counting is a logging-type side effect, not a state change a user would notice. It burns
  nothing, and the response is `no-store` (`API_HEADERS`), so no cache answers in place of the Function.
- Prefetch: `<link rel=prefetch>` and link-preview bots fetch the HTML but do not run JS, so they are not counted.
  Prerender (Speculation Rules, or browser address-bar prerendering) does run JS. The page must therefore delay
  `fetchLimits` until the document is activated: if `document.prerendering` is true, wait for one
  `prerenderingchange` event. Put this in a DOM-free helper `whenActivated(doc)` in `src/web/` so it can be tested.
- The beacon runs once per document, on the initial run of `main.ts`. A back/forward (bfcache) restore does not
  count again; with the live `no-store` headers Chromium keeps the page out of the bfcache anyway.
- The fragment is never sent. The request URL is a constant string with no `location` input, there is no body, the
  site-wide policy is `Referrer-Policy: no-referrer`, and a fetch never puts the fragment in `Referer` anyway.
- `view=app` is sent only when `__SITE__ === "app"` (Vite define, dead code in other builds). The self-host and info
  builds never contain it.
- Recipients opening a link also load `/`, so `view` counts all page loads (create and open views together). Telling
  them apart would mean sending something derived from the fragment. Not done.

### 4. Kind on create and reveal: query parameter `kind`

- Wire form: `POST /api/secrets?ttl=<s>&kind=<kind>` and `POST /api/secrets/<id>/reveal?kind=<kind>`. The web page
  and the CLI send nothing else new.
- **Query parameter, not header.** It matches the existing `ttl` parameter. The router already routes on
  `url.pathname`, so old routers ignore it (`createSecret` reads only `ttl`; the reveal route never reads the query).
  New clients therefore keep working against older self-hosted servers. A header gives no privacy gain: Cloudflare, as
  host, sees URL and headers alike; Functions logs and Logpush are off; and the kind is already visible in the blob.
- Validation, in the router: `parseKind(url.searchParams.get("kind"))` returns the value if it is exactly one of the
  four kinds, otherwise `unknown` (missing, empty, repeated or first value invalid, other case, long or odd strings).
  The kind **never** causes an error and never changes the response, so CLIs up to 0.4.0 keep working and are counted
  as `unknown`.
- A client can lie about the kind (for example a file sent as `text`). That is accepted: the counter is informational.
  The server must not check kind against blob size, because small files are text-sized.
- The kind is never stored with the secret, never written to D1 or SQLite, never logged, and never returned.

### 5. Router interface (runtime-neutral)

New module `src/worker/usage.ts`, added to `test/runtime-neutral.test.ts`:

```ts
export type UsageKind = "text" | "text-pass" | "file" | "file-pass" | "unknown";
export type UsageEvent = "view" | "create" | "reveal" | "gone";
/** Labels are closed sets: a page name for "view", a kind for the rest. Nothing from the request can reach a sink. */
export type UsageLabel<E extends UsageEvent> = E extends "view" ? "app" : UsageKind;
export interface Usage {
  count<E extends UsageEvent>(event: E, label: UsageLabel<E>): void;
}
export const noUsage: Usage = { count() {} };
export function parseKind(value: string | null): UsageKind;
```

- `Options` gets `usage?: Usage` (default `noUsage`). The router calls it through `safeCount(usage, event, label)`,
  which catches any throw. The call is synchronous and returns `void`, so a sink cannot hold up a response. It is made
  after the store result is known and before the `Response` is built.
- The signature takes only the two closed-set values: no request, URL, id, size, header or time. The type system
  keeps request data out of a sink, and the tests check it at runtime too (see Tests).
- Shared client half: `src/shared/usage.ts` exports `USAGE_KINDS` and
  `kindFor({ file, passphrase }): "text" | "text-pass" | "file" | "file-pass"`. The web page and the CLI both use it,
  so the names are defined in one place. `src/worker/usage.ts` imports the kind list from it.

### 6. Analytics Engine adapter and Pages wiring

- `src/worker/usage-ae.ts` (Cloudflare-specific, next to `store-d1.ts`, **not** in the runtime-neutral list):
  `analyticsEngineUsage(dataset: AnalyticsEngineDataset | undefined): Usage`. If the binding is undefined (local
  `wrangler pages dev`, a misconfigured deploy) it returns `noUsage`. Otherwise it calls
  `dataset.writeDataPoint({ blobs: [event, label], indexes: [event] })` inside `try/catch`, not awaited and without
  `waitUntil` (per the docs, the runtime writes in the background). No doubles: count with `SUM(_sample_interval)`.
- The index is the event name, so sampling (if it ever happens) is balanced per event.
- Do not put the adapter under `functions/`: every file there can become a route.
- `functions/api/[[path]].ts`: `handle(context.request, d1Store(context.env.DB), context, { usage: analyticsEngineUsage(context.env.USAGE) })`.
- `src/worker/env.d.ts`: `USAGE?: AnalyticsEngineDataset` (optional on purpose, see above).
- `wrangler.jsonc` adds the following, with a comment that the dataset is created on first write and that only event
  and label are written:
  ```jsonc
  "analytics_engine_datasets": [{ "binding": "USAGE", "dataset": "onetime_usage" }]
  ```
- What ends up in a row: `blob1` = event, `blob2` = label, `index1` = event, plus the columns Analytics Engine adds
  itself (`timestamp`, `_sample_interval`). No id, key, blob, size or bucket, IP, user agent, country, colo, Referer or
  URL.

### 7. Self-hosting: no-op, no setting

`server/http.ts` passes no `usage`, so the router keeps `noUsage`. Analytics Engine does not exist off Cloudflare. A
local counter would add SQLite writes, a retention policy, a viewer and a second set of privacy texts for the
self-host profile; that is not worth it now. Self-hosted servers receive and ignore `kind` (from the shared web code and
the CLI). The self-host page never sends `view=app`, so its texts ("runs no analytics") stay true. Operators who want
numbers can read their own proxy logs, which is their decision and already covered by the self-host privacy wording.

### 8. Viewer: `tools/stats.mjs` (private, owner-run)

- Environment only: `ONETIME_STATS_ACCOUNT_ID` and `ONETIME_STATS_TOKEN`. Any argument that looks like a token or
  account (`--token`, `--account`, or a 40+ character argument) is refused with exit 2 and the message "pass the token
  in the environment". Arguments allowed: `--days N` (1 to 92; retention is 3 months), `--format table|tsv`.
- Fixed host `https://api.cloudflare.com`, `redirect: "error"`, 20 s timeout, response capped at 1 MiB, error
  messages without the token or the Authorization header.
- Query (one request per run; the free plan includes 10,000 per day):
  ```sql
  SELECT formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' DAY), '%Y-%m-%d') AS day,
         blob1 AS event, blob2 AS label, SUM(_sample_interval) AS n
  FROM onetime_usage
  WHERE timestamp > now() - INTERVAL '<days>' DAY
  GROUP BY day, event, label
  ORDER BY day
  FORMAT JSON
  ```
  `<days>` is a validated integer. The script builds the SQL from constants plus that integer, and never from other
  input.
- Output: one row per day with these columns: `views`, then `created`, `revealed` and `gone`, each split into `text`,
  `text-pass`, `file`, `file-pass` and `unknown`. Days without data show 0. Labels outside the closed sets are summed
  into `unknown`, so a bad writer cannot inject text into the table.
- The script is a pure function plus a thin entry, like the CLI (`tools/stats-core.mjs` + `tools/stats.mjs`), so the
  query builder, response parser and table can be tested without the network.
- Not shipped: `tools/` is not copied into any `dist*` output.

## Texts that must change

Rule: every change sits inside `<!-- site:onetimepass -->` blocks. The `site:selfhost` variants stay as they are,
because self-host counts nothing. The FAQPage JSON-LD must equal the visible FAQ text. Update `sitemap.xml` `lastmod`
for changed pages.

Core sentence for all texts (the `web-designer` may shorten it, but the facts must stay): "The secret site counts, per
day, how often its page is loaded and how many links of each kind (text or file, with or without passphrase) are
created, opened, or found already gone. These are totals only: no IP address, cookie, link id or any other identifier
is recorded, and nothing is sent to another site. The totals are stored with Cloudflare, the host, for 3 months."

| Where | Today | Change to |
|---|---|---|
| `index.html` summary (onetimepass block) | "This page loads nothing from other sites and has no analytics." | "This page loads nothing from other sites and runs no tracking; the site keeps only daily totals of page loads and links, without IP addresses, cookies or identifiers." |
| Footers of `privacy.html`, `how-it-works.html`, `terms.html` (onetimepass block) | "onetimepass.pages.dev, where secrets are created and opened, has no analytics or cookies." | "onetimepass.pages.dev, where secrets are created and opened, sets no cookies and keeps only daily totals without identifiers." |
| `command-line.html` footer (onetimepass block) | "No page of this site uses analytics or cookies." | "No page of this site sets cookies or loads anything from other sites; it keeps only daily totals without identifiers." |
| `privacy.html` `#sites` | "It runs no analytics, sets no cookies and loads nothing from other sites, on any page." | "It sets no cookies, loads nothing from other sites and runs no analytics service; it only counts daily totals (see <a href="#counts">Daily totals</a>)." |
| `privacy.html` `#secrets` | "The secret site (onetimepass.pages.dev) sets no cookies, runs no analytics and loads nothing from other sites." | "The secret site (onetimepass.pages.dev) sets no cookies, loads nothing from other sites and keeps only the daily totals described below." |
| `privacy.html` new section `#counts` "Daily totals" (onetimepass only) | none | The core sentence, plus: which events, that the CLI and the page send the kind of link with create and reveal, that it is the same kind the encrypted data already shows, retention 3 months (Analytics Engine), that anyone can make the numbers wrong and they are used only to see how much the site is used, and that legal basis is per the owner (see Owner actions). |
| `how-it-works.html` "Not stored" list (onetimepass) | "Analytics (none on the secret site)" | "Tracking or analytics scripts (none on the secret site; it keeps only daily totals, see <a href="/privacy#counts">privacy</a>)" |
| `how-it-works.html` "Stored" list or server section (onetimepass) | none | "Daily totals: page loads, and links created, opened or already gone, by kind. No id, key, IP or other detail." |
| `how-it-works.html` FAQ "Does the site use cookies or analytics?" + JSON-LD (onetimepass) | "...loads nothing from other sites and has no analytics or cookies on any page." | "...loads nothing from other sites and sets no cookies on any page. It counts only daily totals of page loads and links by kind, with no identifiers." (rest unchanged) |
| `how-it-works.html` hint "loads no third-party scripts, fonts or trackers" | stays true | unchanged |
| `README.md` line "The page where secrets are created and opened loads nothing from other sites and has no analytics or cookies." | | "...loads nothing from other sites and sets no cookies; the app counts only daily totals (page loads; secrets created, revealed or gone by kind) in Cloudflare Workers Analytics Engine, with no identifiers (docs/plans/usage-counters.md)." Also the API section: document `kind` and `view`. File table: `command-line.html` "no analytics" stays true (not counted). |
| `command-line.html` body, near privacy notes (both profiles may say it; true for both) | | "`send` and `get` tell the server the kind of link (text or file, passphrase or not). The hosted service adds it to daily totals; it is never stored with the secret." For self-host: "...the server ignores it." Use profile blocks. |
| `terms.html` | no analytics statement besides footer | footer only |

`CLAUDE.md` (main session or developer, after the owner's OK; architecture rules):

- "Rules that must hold", new bullet: "Usage counters (docs/plans/usage-counters.md) write only an event and a label
  from closed sets (`view/app`, `create|reveal|gone` × `text|text-pass|file|file-pass|unknown`) to Workers Analytics
  Engine through the injected `Usage` sink. Never an id, key, blob, size, IP, user agent, country or any other request
  detail. Never D1. A counter write never fails or changes a response. The kind is never an error and never stored with
  a secret."
- "Privacy wording" bullet: replace "the app origin (secret page, command-line page, CLI downloads, API) sets no
  cookies, runs no analytics and loads nothing external" with "the app origin (secret page, command-line page, CLI
  downloads, API) sets no cookies, loads nothing external and runs no analytics service or tracking script; it keeps
  only identifier-free daily totals (page loads of `/`; created, revealed and gone by kind) in Workers Analytics Engine
  for 3 months; never say it counts nothing, and never call the totals personal data or say they include visitors".
- "Analytics" section: "the app origin never does" (GA) stays. Add: "The app's own daily totals are not analytics in
  the GA sense: no cookie, no client id, no third party. See docs/plans/usage-counters.md."
- "Pages and content": `command-line.html` "(no analytics ...)" stays true.
- "Known open points": add "Usage counters can be inflated by anyone (no rate limit). Each counted request is an
  existing request; the Analytics Engine free amount (100,000 points per day) and what happens past it are
  unverified."

## Tests

Red first, in this order.

1. **`test/contract/api-contract.ts` (both stores)** with a recording `Usage` (`{ calls: [event, label][] }`):
   - text create with `kind=text` gives 201 and `[["create","text"]]`; each of the four kinds the same way.
   - no `kind`, `kind=`, `kind=TEXT`, `kind=file&kind=text` where the first is invalid, a 300-character value, and
     `kind=%00` all give 201 and `unknown`. The response body and headers are the same as without `kind`.
   - 400, 409 (large TTL and near-full), 413, 415 and 503 record nothing.
   - reveal gives 200 with the same bytes as before and `["reveal",k]`; a second reveal gives 404 and `["gone",k]`.
     Missing kind gives `unknown`.
   - GET status (200 and 404), GET on the reveal path (405) and malformed ids record nothing.
   - 20 concurrent reveals of one id: exactly one `reveal` and 19 `gone`.
   - a `Usage` whose `count` throws: every response is the same as with `noUsage` (create 201, reveal bytes the same,
     limits body the same).
   - After a whole flow, `JSON.stringify(calls)` contains neither the id, nor the key, nor any blob byte sequence, and
     every entry is in the closed set.
2. **`test/api-limits.test.ts`**: `?view=app` with `Sec-Fetch-Site: same-origin` records `["view","app"]`. Without the
   header, with `cross-site`/`same-site`/`none`, `view=cli`, `view=` or no `view`, nothing is recorded. POST gives 405
   and records nothing. The body is byte-identical in all cases.
3. **`test/runtime-neutral.test.ts`**: add `src/worker/usage.ts` (and `src/shared/usage.ts`). The router still matches
   no `Cloudflare.`, `ExecutionContext` or `writeDataPoint`. Add a structural check that `index.ts` calls the sink only
   with string literals or a `parseKind(...)` result, not with request variables: a regex over the `safeCount(`
   calls (the same `?raw` source-test style as the existing runtime-neutral test).
4. **Adapter test (Workers runtime)**: a fake dataset records `writeDataPoint` arguments. The argument has exactly the
   keys `blobs` and `indexes`, with `blobs` equal to `[event,label]` and `indexes` equal to `[event]`. An undefined
   binding gives a no-op. A throwing `writeDataPoint` is swallowed. A test checks that
   `functions/api/[[path]].ts` passes `usage: analyticsEngineUsage(context.env.USAGE)`.
5. **`test/web.test.ts` (DOM-free)**: `kindFor` covers all four combinations, and a v1 link gives `text`.
   `createSecret(blob, ttl, kind)` requests exactly `/api/secrets?ttl=<n>&kind=<k>`. `revealSecret(id, { kind })`
   requests `/api/secrets/<id>/reveal?kind=<k>` (stubbed `fetch`). `fetchLimits({ view: true })` requests exactly
   `/api/limits?view=app`; without it, `/api/limits`. No URL contains `#` or a key. `whenActivated` with a fake
   document: it resolves at once when not prerendering, and after `prerenderingchange` when prerendering.
6. **CLI (`test/cli-core.test.ts`, real router, recording `Usage`)**: `send` → `create/text`; `--passphrase-file` →
   `text-pass`; `--file` → `file`; `--file --passphrase-file` → `file-pass`; `get` on `2fp` → `reveal/file-pass`;
   `get` on a used link → `gone/<kind>`; v1 link → `text`. Each request URL has only `ttl` and `kind` (create) or only
   `kind` (reveal). stdout, stderr and exit codes are unchanged. `status` sends no `kind`. Bump the CLI version to
   0.5.0.
7. **Node (`test/node/`)**: the self-host server answers `/api/limits?view=app` with the same body. A self-host build
   contains no `view=app` (`check-selfhost` or `site-profile` test). `tools/stats-core.mjs`: query text for
   `--days 30`; refuses `--days 0`, `--days 93` and `--token x`; parses the JSON reply into the table (missing days =
   0, unknown labels folded); refuses a reply over 1 MiB; the token never appears in thrown messages. The fetch is
   faked.
8. **`tools/check-dist.mjs`**: the info and self-host profiles must not contain `view=app`. The app profile must
   contain it exactly once, in the main entry chunk, and `_routes.json` must still include only `/api/*` as
   today, so counters never route pages through the Function. The existing analytics-string rule (Google strings) stays
   as is; the new code uses the word "usage", not "analytics".
9. **e2e (optional, `pnpm e2e`)**: one load of `/` and of `/#2.<id>.<key>` makes exactly one request to
   `/api/limits?view=app`; no request URL or body contains the fragment.

## Lane split (one branch `feat/usage-counters`, one agent at a time on shared files)

1. **developer**: `src/shared/usage.ts`, `src/worker/usage.ts`, router changes in `src/worker/index.ts`,
   `src/worker/usage-ae.ts`, `functions/api/[[path]].ts`, `src/worker/env.d.ts`, `wrangler.jsonc`, tests 1 to 4, then
   CLI 0.5.0 (`cli/core.ts`, test 6), then `tools/stats-core.mjs` + `tools/stats.mjs` + check-dist rule (tests 7
   and 8). Check that `wrangler pages dev` still starts with the new binding (local AE is unsupported; the adapter
   must see `undefined` or a stub, and the developer records which).
2. **frontend-dev** (after 1, because it uses `src/shared/usage.ts`): `src/web/api.ts` (`kind` on create and reveal,
   `view` on `fetchLimits`), `whenActivated` helper, `src/web/main.ts` wiring (`kindFor` from the chosen mode and
   passphrase on create, from `parseFragment` on reveal; `view` only when `__SITE__ === "app"`), test 5, optional
   test 9.
3. **web-designer** (after 2, so the texts describe shipped behaviour): the text table above in all three profiles,
   the FAQ JSON-LD, `sitemap.xml` lastmod, README. CLAUDE.md lines by the main session after the owner's OK.
4. **code-reviewer** on the whole branch, then `pnpm check` green, then fast-forward merge.

Ordering risk: `src/worker/index.ts`, `cli/core.ts` and `src/web/main.ts` are hot files. Do not run this branch in
parallel with another branch that touches them. The 256 KiB re-spike branch only touches limits, but if it lowers
`MAX_FILE_BYTES` first, rebase.

## Deploy

No D1 migration. Two-step deploy as usual, from the same green commit:

1. Info first: the texts announce the totals before counting starts. The reverse order would count without telling
   anyone.
2. Then the app, with the binding.

After the app deploy, run the usual curl checks. Then make one create and reveal of each kind (the counts will include
them) and run `tools/stats.mjs --days 1` to confirm the dataset exists and rows arrive. How long ingestion takes is not
documented on the pages read, so allow several minutes before treating it as a failure.

## Owner actions before deploy

1. Approve the new privacy wording (section "Texts") and the decisions above, in particular counting `gone`, not
   counting `/command-line`, and keeping self-host as a no-op.
2. Decide the legal basis for the privacy page: legitimate interest, with no consent banner because there is no cookie,
   no device access and no identifier. This is the architect's reading, not legal advice.
3. Create a separate **read-only** API token with "Account / Account Analytics / Read" for `tools/stats.mjs`. Keep it in
   the password store, out of the repo and out of argv, and do not add this permission to the deploy token.
4. Check whether the deploy token can deploy a Pages project with an `analytics_engine_datasets` binding. The docs read
   do not say which permission a binding needs. If the deploy fails with an authorization error, extend the token or
   add the binding once in the dashboard (Settings > Bindings > Analytics engine) and say which in this ADR.
5. Confirm in the dashboard that Functions logs and Logpush are still off. URLs now also carry `kind`; it is harmless
   but must not start a log.
6. Approve the info deploy and the app deploy separately, as usual.

## Risks

- **Inflation.** Anyone can raise any counter with curl (fake `Sec-Fetch-Site`, fake kinds, real creates and reveals).
  This is accepted: the numbers are informational and gate nothing. Cheap mitigations without identifiers are in place:
  closed label sets, GET and POST semantics as today, a same-origin header for views, and one data point per request.
  A real fix needs the rate limit that is already an open point.
- **Free amounts.** 100,000 data points per day. Behaviour past that is undocumented. The sink swallows errors, and the
  API path never depends on a write. Counted requests are requests the API already gets, so the counters add no
  Function invocations.
- **Correlation.** Analytics Engine keeps the full timestamp of each row. Someone with the read token could line a
  `create/file-pass` timestamp up with a D1 row (`expires_at - ttl`). That reveals only what the blob's flags byte
  already shows. `tools/stats.mjs` shows daily totals only.
- **Local dev.** "You cannot use an Analytics Engine binding locally". The adapter treats a missing binding as a no-op;
  `wrangler pages dev` behaviour with the key present has to be confirmed by the developer.

## Not verified

- What Analytics Engine does once the free daily amount is exceeded (drop, throw, or bill later).
- Which token permission `wrangler pages deploy` needs for a project with an Analytics Engine binding.
- That `timestamp` is UTC (assumed; the SQL docs do not say).
- Ingestion delay before rows show up in the SQL API.
- Exact rules for dataset names (`onetime_usage` uses only lowercase letters and an underscore, which should be safe).
