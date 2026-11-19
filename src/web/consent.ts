/** Consent decisions without the DOM, so they can be unit-tested. Holds no analytics provider code or URLs. */

/** Bump when the purposes or providers change: everyone is asked again. */
export const CONSENT_VERSION = 1;
export const CONSENT_STORAGE_KEY = "onetime-consent";
/** Re-ask after 12 months. */
export const CONSENT_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

export type Decision = "accepted" | "rejected";
export interface ConsentRecord {
  version: number;
  decision: Decision;
  /** ISO 8601 time of the choice. */
  date: string;
}

/** Analytics is offered only when a measurement ID is configured. */
export function analyticsEnabled(measurementId: string): boolean {
  return /^G-[A-Z0-9]{4,20}$/.test(measurementId);
}

export function serializeConsent(decision: Decision, now: number): string {
  const record: ConsentRecord = { version: CONSENT_VERSION, decision, date: new Date(now).toISOString() };
  return JSON.stringify(record);
}

/** Returns the stored record, or null when it is missing, malformed, from another version, expired or dated in the future. */
export function parseConsent(raw: string | null | undefined, now: number): ConsentRecord | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { version, decision, date } = value as Record<string, unknown>;
  if (version !== CONSENT_VERSION) return null;
  if (decision !== "accepted" && decision !== "rejected") return null;
  if (typeof date !== "string") return null;
  const time = Date.parse(date);
  if (!Number.isFinite(time)) return null;
  const age = now - time;
  if (age < 0 || age >= CONSENT_MAX_AGE_MS) return null;
  return { version, decision, date };
}

/** The cookies the analytics provider sets: `_ga` and `_ga_<ID>`. */
export function isAnalyticsCookieName(name: string): boolean {
  const n = name.trim();
  return n === "_ga" || /^_ga_[A-Za-z0-9]+$/.test(n);
}

/** Names of analytics cookies in a `document.cookie` string. */
export function analyticsCookieNames(cookieString: string): string[] {
  return cookieString
    .split(";")
    .map((part) => part.split("=")[0]?.trim() ?? "")
    .filter(isAnalyticsCookieName);
}

/** Expiry strings that delete a cookie on this host and on the parent-domain variants. */
export function cookieDeletionStrings(name: string, hostname: string): string[] {
  const base = `${name}=; Max-Age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  const parts = hostname.split(".");
  const domains = new Set<string>();
  for (let i = 0; i <= parts.length - 2; i++) domains.add("." + parts.slice(i).join("."));
  const out = [base];
  if (parts.length >= 2) for (const d of domains) out.push(`${base}; domain=${d}`);
  return out;
}

/** The only location sent to analytics: origin and path, never query or fragment. */
export function sanitizePageLocation(href: string): string {
  try {
    const url = new URL(href);
    return url.origin + url.pathname;
  } catch {
    return "";
  }
}
