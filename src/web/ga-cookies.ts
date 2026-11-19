import { CONSENT_STORAGE_KEY, analyticsCookieNames, cookieDeletionStrings, parseConsent } from "./consent";

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
