import { CONSENT_STORAGE_KEY, analyticsCookieNames, cookieDeletionStrings, legacyPurgeActions, parseConsent } from "./consent";

/** Deletes `_ga` and `_ga_*` cookies on this host and its parent-domain variants. Returns whether any were present. */
export function deleteAnalyticsCookies(): boolean {
  const names = analyticsCookieNames(document.cookie);
  for (const name of names) for (const s of cookieDeletionStrings(name, location.hostname)) document.cookie = s;
  return names.length > 0;
}

export function readConsentDecision(): "accepted" | "rejected" | null {
  try {
    return parseConsent(localStorage.getItem(CONSENT_STORAGE_KEY), Date.now())?.decision ?? null;
  } catch {
    return null;
  }
}

/** On every page: without a valid acceptance, leftover analytics cookies are removed. */
export function clearLeftoverAnalyticsCookies(): void {
  if (readConsentDecision() !== "accepted") deleteAnalyticsCookies();
}

/**
 * App and self-host origins: analytics never runs there, so anything an earlier version left behind goes, on every
 * visit and whatever the stored choice says: `_ga*` cookies and the consent record (the choice now lives on the info
 * site only). Remove this after 2027-12-31, when cookies set before the split have expired (they lasted 12 months).
 */
export function purgeLegacyAnalyticsState(): void {
  const { cookieWrites, storageKeys } = legacyPurgeActions(document.cookie, location.hostname);
  for (const write of cookieWrites) document.cookie = write;
  try {
    for (const key of storageKeys) localStorage.removeItem(key);
  } catch {
    // Storage blocked: nothing to remove.
  }
}
