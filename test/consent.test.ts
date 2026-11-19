import { describe, expect, it } from "vitest";
import { GA_MEASUREMENT_ID } from "../src/web/analytics-config";
import { cliDownloadKind } from "../src/web/analytics-events";
import {
  CONSENT_MAX_AGE_MS,
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

describe("cliDownloadKind", () => {
  it("maps download paths to a fixed enum", () => {
    expect(cliDownloadKind("/cli/onetime.mjs")).toBe("script");
    expect(cliDownloadKind("/cli/onetime.cmd")).toBe("windows_shim");
    expect(cliDownloadKind("/cli/onetime.mjs.sha256")).toBe("checksum");
    expect(cliDownloadKind("/cli/other")).toBeNull();
    expect(cliDownloadKind("/")).toBeNull();
  });
});
