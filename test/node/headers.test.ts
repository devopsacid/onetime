import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { headersFor, HeadersFileError, parseHeaders } from "../../server/headers";
import { headersForInfo, INFO_CSP } from "../../tools/site-profile-core.mjs";
import { PUBLIC_HEADERS } from "./helpers";

const get = (list: [string, string][], name: string) => list.find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1];

describe("parseHeaders and headersFor", () => {
  it("applies every matching rule in file order and joins repeated headers with ', '", () => {
    const rules = parseHeaders("/*\n  Vary: a\n/x\n  Vary: b\n  X-One: 1\n/y\n  X-Two: 2\n");
    expect(headersFor(rules, "/x")).toEqual([
      ["Vary", "a, b"],
      ["X-One", "1"],
    ]);
    expect(headersFor(rules, "/y")).toEqual([
      ["Vary", "a"],
      ["X-Two", "2"],
    ]);
  });

  it("detaches with '! Name' what earlier rules added, and keeps what a later line sets", () => {
    const rules = parseHeaders("/*\n  A: 1\n  B: 1\n/x\n  ! A\n  C: 1\n/y\n  ! A\n  A: 2\n");
    expect(headersFor(rules, "/x")).toEqual([
      ["B", "1"],
      ["C", "1"],
    ]);
    expect(headersFor(rules, "/y")).toEqual([
      ["B", "1"],
      ["A", "2"],
    ]);
  });

  it("only detaches what came earlier, not later rules", () => {
    const rules = parseHeaders("/x\n  ! A\n/*\n  A: late\n");
    expect(get(headersFor(rules, "/x"), "A")).toBe("late");
  });

  it("matches a splat against zero or more characters, so /* matches /", () => {
    const rules = parseHeaders("/*\n  All: yes\n/assets/*\n  Asset: yes\n/a*c\n  Mid: yes\n");
    expect(get(headersFor(rules, "/"), "All")).toBe("yes");
    expect(get(headersFor(rules, "/assets/"), "Asset")).toBe("yes");
    expect(get(headersFor(rules, "/assets/x/y.js"), "Asset")).toBe("yes");
    expect(get(headersFor(rules, "/assets"), "Asset")).toBeUndefined();
    expect(get(headersFor(rules, "/ac"), "Mid")).toBe("yes");
    expect(get(headersFor(rules, "/abbbc"), "Mid")).toBe("yes");
    expect(get(headersFor(rules, "/abbbd"), "Mid")).toBeUndefined();
  });

  it("matches exact paths exactly and treats regex characters literally", () => {
    const rules = parseHeaders("/a.b\n  X: 1\n");
    expect(headersFor(rules, "/a.b")).toEqual([["X", "1"]]);
    expect(headersFor(rules, "/aXb")).toEqual([]);
  });

  it("treats header names case-insensitively for joining and detaching", () => {
    const rules = parseHeaders("/*\n  x-test: 1\n/x\n  X-Test: 2\n/y\n  ! X-TEST\n");
    expect(headersFor(rules, "/x")).toEqual([["x-test", "1, 2"]]);
    expect(headersFor(rules, "/y")).toEqual([]);
  });

  it("ignores comments and blank lines and keeps colons inside values", () => {
    const rules = parseHeaders("# top\n\n/x\n  # inner\n  Link: <https://a.example/b>; rel=x\n");
    expect(headersFor(rules, "/x")).toEqual([["Link", "<https://a.example/b>; rel=x"]]);
  });

  it.each([
    ["a placeholder", "/blog/:slug\n  X: 1\n"],
    ["an absolute URL pattern", "https://example.com/*\n  X: 1\n"],
    ["a :splat in a value", "/*\n  Link: </:splat>\n"],
    ["two splats", "/*/a/*\n  X: 1\n"],
    ["a header before any pattern", "  X: 1\n"],
    ["a pattern without a leading slash", "x\n  X: 1\n"],
    ["a malformed header line", "/x\n  nocolon\n"],
    ["a line over 2000 characters", `/x\n  X: ${"a".repeat(2001)}\n`],
  ])("refuses %s", (_name, text) => {
    expect(() => parseHeaders(text)).toThrow(HeadersFileError);
  });

  it("refuses more than 100 rules and accepts exactly 100", () => {
    const rules = (n: number) => Array.from({ length: n }, (_, i) => `/p${i}\n  X: 1\n`).join("");
    expect(() => parseHeaders(rules(100))).not.toThrow();
    expect(() => parseHeaders(rules(101))).toThrow(HeadersFileError);
  });
});

describe("the real public/_headers", () => {
  const rules = parseHeaders(readFileSync(PUBLIC_HEADERS, "utf8"));
  const csp = (path: string) => get(headersFor(rules, path), "Content-Security-Policy");
  const STRICT = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

  it.each(["/", "/index.html", "/404", "/404.html", "/command-line", "/command-line.html", "/how-it-works", "/privacy.html", "/assets/main-abc.js", "/cli/onetime.mjs", "/robots.txt", "/nope"])(
    "serves the strict CSP exactly once on %s",
    (path) => {
      expect(csp(path)).toBe(STRICT);
    },
  );

  it("has exactly one CSP line, in /*, no detach lines and no Google host anywhere", () => {
    const text = readFileSync(PUBLIC_HEADERS, "utf8");
    expect(text.match(/Content-Security-Policy/gi)).toHaveLength(1);
    expect(text).not.toMatch(/^\s*!/m);
    expect(text).not.toMatch(/google|gtag|analytics/i);
    expect(parseHeaders(text).find((r) => r.pattern === "/*")).toBeDefined();
  });

  it("sets no-store on the HTML paths", () => {
    for (const path of ["/", "/index.html", "/how-it-works", "/command-line", "/privacy", "/terms", "/terms.html", "/404", "/privacy.html"]) {
      expect(get(headersFor(rules, path), "Cache-Control")).toBe("no-store");
    }
  });

  it("sets immutable only under /assets/", () => {
    expect(get(headersFor(rules, "/assets/main-abc.js"), "Cache-Control")).toBe("public, max-age=31536000, immutable");
    for (const path of ["/", "/robots.txt", "/cli/onetime.mjs", "/favicon.svg"]) {
      expect(get(headersFor(rules, path), "Cache-Control")).not.toBe("public, max-age=31536000, immutable");
    }
  });

  it.each(["/", "/index.html", "/404", "/privacy", "/how-it-works.html", "/assets/main-abc.js", "/cli/onetime.mjs", "/robots.txt", "/og-image.png"])(
    "turns powerful features off and sets CORP same-origin on %s",
    (path) => {
      const list = headersFor(rules, path);
      expect(get(list, "Cross-Origin-Resource-Policy")).toBe("same-origin");
      const policy = get(list, "Permissions-Policy")!;
      for (const feature of ["accelerometer", "camera", "geolocation", "gyroscope", "magnetometer", "microphone", "payment", "usb", "browsing-topics"]) {
        expect(policy).toContain(`${feature}=()`);
      }
      // The copy button needs clipboard-write for the page itself.
      expect(policy).toContain("clipboard-write=(self)");
      expect(policy).not.toMatch(/clipboard-write=\(\)/);
    },
  );

  it("marks /cli/* noindex and keeps the other security headers everywhere", () => {
    expect(get(headersFor(rules, "/cli/onetime.mjs"), "X-Robots-Tag")).toBe("noindex");
    expect(get(headersFor(rules, "/"), "X-Robots-Tag")).toBeUndefined();
    for (const name of ["Referrer-Policy", "X-Content-Type-Options", "X-Frame-Options", "Cross-Origin-Opener-Policy", "Strict-Transport-Security"]) {
      expect(get(headersFor(rules, "/privacy"), name)).toBeDefined();
    }
  });
});

describe("headers of the info site (headersForInfo of the real file)", () => {
  const rules = parseHeaders(headersForInfo(readFileSync(PUBLIC_HEADERS, "utf8")));
  it.each(["/how-it-works", "/how-it-works.html", "/privacy", "/privacy.html", "/terms", "/terms.html", "/404", "/assets/x.js", "/og-image.png"])("serves INFO_CSP once on %s", (path) => {
    const list = headersFor(rules, path).filter(([n]) => n.toLowerCase() === "content-security-policy");
    expect(list).toEqual([["Content-Security-Policy", INFO_CSP]]);
  });
  it("sets no-store on its pages and keeps the shared security headers", () => {
    for (const path of ["/how-it-works", "/privacy", "/terms", "/terms.html", "/404"]) {
      expect(get(headersFor(rules, path), "Cache-Control")).toBe("no-store");
      expect(get(headersFor(rules, path), "Cross-Origin-Resource-Policy")).toBe("same-origin");
      expect(get(headersFor(rules, path), "Permissions-Policy")).toContain("clipboard-write=(self)");
    }
  });
  it("has no rules for the app-only paths", () => {
    expect(rules.map((r) => r.pattern)).not.toEqual(expect.arrayContaining(["/cli/*"]));
    expect(get(headersFor(rules, "/cli/onetime.mjs"), "X-Robots-Tag")).toBeUndefined();
  });
});
