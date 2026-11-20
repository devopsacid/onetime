# ADR: shorter maximum expiry when the store is nearly full (replaces security plan item 7)

Status: accepted by the owner on 2026-11-20 (no custom domain, so no WAF rate limit; this measure only). Implemented on branch `sec/near-full-ttl`.

## Recommendation

While more than 80 % of the cap is in use, `POST /api/secrets` with a TTL longer than one day is **refused with 409** and a `maxTtl` field; it is never silently shortened. Clients tell the user and let them choose again. The check is the existing single capped insert with a smaller cap for long TTLs, so there is no new statement and no race.

## Context

- Cap: `MAX_STORED_SECRETS = 20_000` (`src/shared/limits.ts`); the router passes `maxStored` to `store.insertIfBelowCap(id, blob, expiresAt, now, maxStored)` (`src/worker/store.ts`), one atomic statement. Phase 1 item 1 of `docs/plans/security-hardening.md` turns its `COUNT(*)` into the counter row `stats(stored)`; the statement stays one `INSERT ... SELECT ... WHERE (SELECT stored ...) < ?cap`.
- Without a rate limit an attacker can fill the cap. With 7-day TTLs one fill blocks creates for 7 days.

## Decisions

1. **Rule.** `ttl > NEAR_FULL_MAX_TTL_SECONDS` (86,400) is a long TTL. The router computes
   `cap = ttl > NEAR_FULL_MAX_TTL_SECONDS ? longTtlCap(maxStored) : maxStored`,
   `longTtlCap(m) = Math.max(1, Math.floor((m * 4) / 5))` (16,000 for the default cap), and calls `insertIfBelowCap(..., cap)`. Exactly 86,400 s (the "1 day" option) is not long.
2. **Atomicity.** No store, SQL or interface change: the same single statement runs with a different bound, so concurrent creates can never put more than `longTtlCap` rows in via long TTLs, nor more than `maxStored` in total. Works identically before and after the counter-row migration, in D1 and SQLite.
3. **Responses.**
   - Long TTL and the insert refused: `409`, `{ "error": "The service is nearly full, so new links can last at most 1 day right now.", "maxTtl": 86400 }`, `API_HEADERS`, no `Retry-After`.
   - Short TTL refused: `503` as today (`Retry-After: 300`).
   - A long-TTL request while the store is completely full also gets 409 (the router cannot tell the two cases apart without a second query); the follow-up 1-day request then gets 503. Accepted: no extra read, no race, the message stays true ("at most 1 day").
   - Why refuse, not clamp: a clamped link would expire earlier than the sender was told. Today's clients print the chosen expiry ("Expires in 7 days" in the CLI hints, the TTL label in the web "created" view) and would print it wrongly; a refusal reaches every client, old or new, as an honest error.
4. **Web (`src/web/api.ts`, `main.ts`, new DOM-free `src/web/ttl.ts`).** `ApiError` gets an optional `maxTtl` (read from the JSON body only if it is a safe integer in `[MIN_TTL_SECONDS, MAX_TTL_SECONDS]`). On 409 with `maxTtl`: select the largest `<option>` of `#ttl` whose value ≤ `maxTtl` (`pickTtlOption(maxTtl, values)` in `ttl.ts`), keep the secret in the field, show in `#create-error`: "The service is nearly full, so links can last at most 1 day right now. Expiry is now set to 1 day: press Create link again." and focus the create button. No automatic retry (the sender decides).
5. **CLI (`cli/core.ts`).** On 409 with a valid `maxTtl`: exit 5 with "The service is nearly full right now, so links can last at most 1 day. Run the command again with --ttl 1d or shorter." (`describeTtl(maxTtl)` builds "1 day"). No automatic retry. Older CLIs print "The server answered 409: <error>" and exit 5, which is also true.
6. **Self-host.** Same router, same rule against the operator's `maxStored`.

## Texts

- `how-it-works.html` FAQ "How large can a secret be?" (both profiles, and its FAQPage JSON-LD): add "While more than 80 % of that is in use (16,000 on this site), new links can last at most 1 day."
- `README.md` "Limits": same sentence. CLI help `--ttl` line: "(at most 1d while the service is nearly full)". `docs/self-hosting.md`: one line where the cap setting is described.

## Task list (branch `feat/near-full-ttl`, `developer` then `frontend-dev`, `code-reviewer` before merge; after the Phase 1 headers branch, because both edit `src/worker/index.ts`)

1. `test/contract/api-contract.ts` (both stores, red first), with `maxStored: 5` (long cap 4): four 7-day creates → 201; fifth 7-day → 409 with `maxTtl: 86400`; 86,400 s → 201; 86,401 s → 409; with 5 stored, 3,600 s → 503; 20 concurrent 7-day creates on an empty store → exactly 4 succeed, the rest 409; `maxStored: 1` → long cap 1. Then `limits.ts` (`NEAR_FULL_MAX_TTL_SECONDS`, `longTtlCap`) and `src/worker/index.ts`.
2. `test/web.test.ts`: `pickTtlOption` (86,400 → 86,400; 3,600 → 3,600; 60 → none, keep selection), `ApiError.maxTtl` parsing (missing, string, out of range). Then `ttl.ts`, `api.ts`, `main.ts`.
3. `test/cli-core.test.ts` through the real router with `maxStored` set: message and exit 5, nothing printed on stdout. Then `cli/core.ts`.
4. Texts; `pnpm check`.

## Risks

- **Weak against a determined attacker.** The first 80 % can still be filled with 7-day links; only the last 20 % then turns over daily, so an attacker must come back every day to keep the site full instead of once a week. It reduces, not removes, the effect of finding 1. The real fix (WAF rate limit) needs a custom domain.
- Legitimate senders lose the 7-day option while the store is above 16,000; the UI says why.

## Owner decisions (defaults let work proceed)

1. Threshold 80 % and maximum 1 day. **Default: yes.**
2. Refuse with 409 rather than clamp. **Default: refuse.**
