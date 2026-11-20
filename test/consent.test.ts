import { afterEach, describe, expect, it, vi } from "vitest";
import { GA_MEASUREMENT_ID } from "../src/web/analytics-config";
import { analyticsAllowedHere } from "../src/web/analytics-origin";
import { purgeLegacyAnalyticsState } from "../src/web/ga-cookies";
import {
  CONSENT_MAX_AGE_MS,
  CONSENT_STORAGE_KEY,
  CONSENT_VERSION,
  analyticsCookieNames,
  analyticsEnabled,
  cookieDeletionStrings,
  isAnalyticsCookieName,
  parseConsent,
  sanitizePageLocation,
  serializeConsent,
} from "../src/web/consent";

const NOW = Date.parse("2026-11-19T12:00:00Z");

describe("analyticsEnabled", () => {
  it("is off for an empty or malformed id, so no banner and nothing loads", () => {
    for (const id of ["", " ", "GTM-TZKWX9H8", "G-", "g-abcd1234", "G-abc d", "UA-12345"]) expect(analyticsEnabled(id)).toBe(false);
  });
  it("is on for a G- measurement id", () => {
    expect(analyticsEnabled("G-ABCDE12345")).toBe(true);
  });
  it("the configured id is a valid GA4 id (and never a GTM container)", () => {
    expect(analyticsEnabled(GA_MEASUREMENT_ID)).toBe(true);
    expect(GA_MEASUREMENT_ID.startsWith("GTM-")).toBe(false);
  });
});

describe("consent record", () => {
  it("round-trips version, decision and date", () => {
    const raw = serializeConsent("accepted", NOW);
    expect(JSON.parse(raw)).toEqual({ version: CONSENT_VERSION, decision: "accepted", date: "2026-11-19T12:00:00.000Z" });
    expect(parseConsent(raw, NOW + 1000)?.decision).toBe("accepted");
    expect(parseConsent(serializeConsent("rejected", NOW), NOW)?.decision).toBe("rejected");
  });
  it("asks again after 12 months", () => {
    const raw = serializeConsent("accepted", NOW);
    expect(parseConsent(raw, NOW + CONSENT_MAX_AGE_MS - 1)).not.toBeNull();
    expect(parseConsent(raw, NOW + CONSENT_MAX_AGE_MS)).toBeNull();
  });
  it("asks again when the version changes", () => {
    const old = JSON.stringify({ version: CONSENT_VERSION + 1, decision: "accepted", date: new Date(NOW).toISOString() });
    expect(parseConsent(old, NOW)).toBeNull();
  });
  it("treats junk and future dates as no decision", () => {
    for (const raw of [null, undefined, "", "x", "null", "[]", "{}", '{"version":1,"decision":"yes","date":"2026-11-19T12:00:00Z"}', '{"version":1,"decision":"accepted","date":"nope"}', '{"version":1,"decision":"accepted"}', serializeConsent("accepted", NOW + 86400000)]) {
      expect(parseConsent(raw, NOW)).toBeNull();
    }
  });
});

describe("cookie names", () => {
  it("matches _ga and _ga_<ID> only", () => {
    for (const n of ["_ga", "_ga_W3GR41J2NR", " _ga"]) expect(isAnalyticsCookieName(n)).toBe(true);
    for (const n of ["_gat", "_gid", "ga", "_ga_", "_gaX", "theme", "_ga_a-b", "x_ga"]) expect(isAnalyticsCookieName(n)).toBe(false);
  });
  it("extracts them from document.cookie", () => {
    expect(analyticsCookieNames("a=1; _ga=GA1.1.2; _ga_W3GR41J2NR=GS2.1; other=3")).toEqual(["_ga", "_ga_W3GR41J2NR"]);
    expect(analyticsCookieNames("")).toEqual([]);
  });
  it("builds host and parent-domain deletion variants", () => {
    const out = cookieDeletionStrings("_ga", "onetimepass.pages.dev");
    expect(out[0]).toContain("path=/");
    expect(out[0]).not.toContain("domain=");
    expect(out.some((s) => s.endsWith("domain=.onetimepass.pages.dev"))).toBe(true);
    expect(out.every((s) => s.includes("Max-Age=0"))).toBe(true);
    expect(cookieDeletionStrings("_ga", "localhost")).toHaveLength(1);
  });
});

describe("sanitizePageLocation", () => {
  it("keeps origin and path, drops query and fragment", () => {
    expect(sanitizePageLocation("https://onetimepass.pages.dev/command-line?x=1#abc.key")).toBe("https://onetimepass.pages.dev/command-line");
    expect(sanitizePageLocation("https://user:pw@onetimepass.pages.dev/privacy?q#f")).toBe("https://onetimepass.pages.dev/privacy");
    expect(sanitizePageLocation("not a url")).toBe("");
  });
});

describe("purgeLegacyAnalyticsState", () => {
  afterEach(() => vi.unstubAllGlobals());
  function stub(cookie: string, hostname = "onetimepass.pages.dev", storage: Record<string, string> = {}) {
    const written: string[] = [];
    const removed: string[] = [];
    vi.stubGlobal("document", {
      get cookie() {
        return cookie;
      },
      set cookie(value: string) {
        written.push(value);
      },
    });
    vi.stubGlobal("location", { hostname });
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => storage[k] ?? null,
      removeItem: (k: string) => {
        removed.push(k);
        delete storage[k];
      },
    });
    return { written, removed, storage };
  }
  it("deletes every _ga cookie (host and parent-domain variants) whatever the consent record says, and the consent record", () => {
    const accepted = serializeConsent("accepted", Date.now());
    const { written, removed, storage } = stub("a=1; _ga=GA1.1.2; _ga_ABC123=GS1; theme=dark", "onetimepass.pages.dev", { [CONSENT_STORAGE_KEY]: accepted });
    purgeLegacyAnalyticsState();
    for (const name of ["_ga", "_ga_ABC123"]) {
      for (const expected of cookieDeletionStrings(name, "onetimepass.pages.dev")) expect(written).toContain(expected);
    }
    expect(written.some((w) => w.startsWith("a=") || w.startsWith("theme="))).toBe(false);
    expect(removed).toEqual([CONSENT_STORAGE_KEY]);
    expect(storage[CONSENT_STORAGE_KEY]).toBeUndefined();
  });
  it("removes the consent record even with no cookies, and leaves the theme alone", () => {
    const { written, removed } = stub("", "onetimepass.pages.dev", { theme: "dark" });
    purgeLegacyAnalyticsState();
    expect(written).toEqual([]);
    expect(removed).toEqual([CONSENT_STORAGE_KEY]);
  });
  it("survives blocked storage", () => {
    stub("_ga=1");
    vi.stubGlobal("localStorage", {
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => purgeLegacyAnalyticsState()).not.toThrow();
  });
});

describe("analyticsAllowedHere", () => {
  it("allows only the info site", () => {
    expect(analyticsAllowedHere("https://onetimepass-info.pages.dev")).toBe(true);
  });
  it("refuses the app origin, where nothing may run analytics", () => {
    expect(analyticsAllowedHere("https://onetimepass.pages.dev")).toBe(false);
  });
  it("refuses forks, previews, localhost and look-alikes", () => {
    for (const origin of [
      "https://x.pages.dev",
      "https://abc123.onetimepass.pages.dev",
      "http://localhost",
      "http://localhost:8080",
      "https://onetimepass.pages.dev.evil.com",
      "http://onetimepass.pages.dev",
      "https://onetimepass.pages.dev:8443",
      "https://my.host",
      "https://onetimepass-info.pages.dev:8443",
      "https://abc123.onetimepass-info.pages.dev",
      "http://onetimepass-info.pages.dev",
      "",
      "null",
    ]) {
      expect(analyticsAllowedHere(origin), origin).toBe(false);
    }
  });
});
