import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyBlocks,
  headersForSelfhost,
  operatorContactHtml,
  operatorNameHtml,
  parseOrigin,
  robotsForSelfhost,
  sitemapForSelfhost,
  transformHtml,
} from "../../tools/site-profile-core.mjs";
import { ROOT } from "./helpers";

// Built from pieces so the owner's address is not spelled out in this file.
const OWNER_MAIL = ["michal", "maxian.sk"].join("@");

const SAMPLE = [
  "<main>",
  "  <p>always</p>",
  "  <!-- site:onetimepass -->",
  "  <p>owner</p>",
  "  <!-- /site:onetimepass -->",
  "  <!-- site:selfhost",
  "  <p>mine {{OPERATOR_NAME}} / {{OPERATOR_CONTACT}} at https://onetimepass.pages.dev/x</p>",
  "  site:selfhost -->",
  "  <p>tail https://onetimepass.pages.dev/</p>",
  "</main>",
  "",
].join("\n");

const OPTS = { origin: "https://my.host", operatorName: undefined, operatorContact: undefined };

describe("applyBlocks", () => {
  it("pages: keeps owner content, drops marker lines and selfhost blocks, byte for byte", () => {
    expect(applyBlocks(SAMPLE, "onetimepass")).toBe(
      ["<main>", "  <p>always</p>", "  <p>owner</p>", "  <p>tail https://onetimepass.pages.dev/</p>", "</main>", ""].join("\n"),
    );
  });
  it("selfhost: drops owner blocks, keeps selfhost content without markers", () => {
    expect(applyBlocks(SAMPLE, "selfhost")).toBe(
      [
        "<main>",
        "  <p>always</p>",
        "  <p>mine {{OPERATOR_NAME}} / {{OPERATOR_CONTACT}} at https://onetimepass.pages.dev/x</p>",
        "  <p>tail https://onetimepass.pages.dev/</p>",
        "</main>",
        "",
      ].join("\n"),
    );
  });
  it("is the identity on text without markers", () => {
    expect(applyBlocks("<p>x</p>\n", "onetimepass")).toBe("<p>x</p>\n");
    expect(applyBlocks("<p>x</p>\n", "selfhost")).toBe("<p>x</p>\n");
  });
  it("rejects nested, unclosed, stray and comment-containing blocks", () => {
    const bad = [
      "<!-- site:onetimepass -->\n<!-- site:selfhost\nx\nsite:selfhost -->\n<!-- /site:onetimepass -->\n",
      "<!-- site:onetimepass -->\nx\n",
      "x\n<!-- /site:onetimepass -->\n",
      "<!-- site:selfhost\nx\n",
      "x\nsite:selfhost -->\n",
      "<!-- site:selfhost\n<!-- inner -->\nsite:selfhost -->\n",
      "<!-- site:selfhost\nx --> y\nsite:selfhost -->\n",
      "<!-- site:onetimepass -->\n<!-- site:onetimepass -->\n<!-- /site:onetimepass -->\n<!-- /site:onetimepass -->\n",
    ];
    for (const text of bad) {
      expect(() => applyBlocks(text, "onetimepass"), text).toThrow();
      expect(() => applyBlocks(text, "selfhost"), text).toThrow();
    }
  });
  it("rejects a marker that shares its line with other text", () => {
    expect(() => applyBlocks("<p>a</p> <!-- site:onetimepass -->\nx\n<!-- /site:onetimepass -->\n", "onetimepass")).toThrow();
  });
});

describe("operator values", () => {
  it("name: escaped, or the generic phrase when unset", () => {
    expect(operatorNameHtml(undefined)).toBe("the operator of this instance");
    expect(operatorNameHtml("")).toBe("the operator of this instance");
    expect(operatorNameHtml(`A & B <"x">'`)).toBe("A &amp; B &lt;&quot;x&quot;&gt;&#39;");
  });
  it("name: rejects control characters and absurd length", () => {
    expect(() => operatorNameHtml("a\nb")).toThrow();
    expect(() => operatorNameHtml("x".repeat(201))).toThrow();
  });
  it("contact: email, https url, or the unset phrase", () => {
    expect(operatorContactHtml(undefined)).toBe("not published on this site");
    expect(operatorContactHtml("me@example.com")).toBe('<a href="mailto:me@example.com">me@example.com</a>');
    expect(operatorContactHtml("https://example.com/contact?a=1&b=2")).toBe(
      '<a href="https://example.com/contact?a=1&amp;b=2">https://example.com/contact?a=1&amp;b=2</a>',
    );
  });
  it("contact: rejects anything else", () => {
    for (const bad of ["http://example.com", "javascript:alert(1)", "not a contact", 'a"b@x.com', "me@x", "https://u:p@example.com", "ftp://x.com", "mailto:me@example.com", "<a>@x.com"]) {
      expect(() => operatorContactHtml(bad), bad).toThrow();
    }
  });
});

describe("parseOrigin", () => {
  it("accepts https origins and http localhost with a port", () => {
    expect(parseOrigin("https://onetime.example")).toBe("https://onetime.example");
    expect(parseOrigin("https://onetime.example:8443")).toBe("https://onetime.example:8443");
    expect(parseOrigin("http://localhost:8080")).toBe("http://localhost:8080");
  });
  it("rejects missing, http elsewhere, paths, credentials and junk", () => {
    for (const bad of [undefined, "", "http://example.com", "https://example.com/path", "https://example.com/", "https://u@example.com", "example.com", "http://localhost", "https://exa mple.com", "https://example.com?x=1", "ftp://example.com"]) {
      expect(() => parseOrigin(bad), String(bad)).toThrow();
    }
  });
});

describe("transformHtml", () => {
  it("pages: blocks only, no origin or placeholder handling", () => {
    expect(transformHtml(SAMPLE, { ...OPTS, profile: "onetimepass" })).toBe(applyBlocks(SAMPLE, "onetimepass"));
  });
  it("selfhost: operator values, origin replaced, no marker or placeholder left", () => {
    const out = transformHtml(SAMPLE, { ...OPTS, profile: "selfhost", operatorName: "Ann & Co", operatorContact: "ann@example.com" });
    expect(out).toContain('<p>mine Ann &amp; Co / <a href="mailto:ann@example.com">ann@example.com</a> at https://my.host/x</p>');
    expect(out).toContain("tail https://my.host/");
    expect(out).not.toMatch(/site:(?:onetimepass|selfhost)|\{\{|onetimepass\.pages\.dev/);
  });
  it("selfhost: unset operator gives the generic texts", () => {
    const out = transformHtml(SAMPLE, { ...OPTS, profile: "selfhost" });
    expect(out).toContain("mine the operator of this instance / not published on this site at");
  });
  it("selfhost: an operator value cannot smuggle a placeholder or markup", () => {
    expect(() => transformHtml(SAMPLE, { ...OPTS, profile: "selfhost", operatorName: "{{OPERATOR_CONTACT}}" })).toThrow();
    const out = transformHtml(SAMPLE, { ...OPTS, profile: "selfhost", operatorName: "<b>x</b>" });
    expect(out).not.toContain("<b>");
    expect(out).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
  it("rejects an unknown placeholder and placeholders in owner blocks", () => {
    expect(() => transformHtml("<!-- site:selfhost\n{{NOPE}}\nsite:selfhost -->\n", { ...OPTS, profile: "selfhost" })).toThrow();
    expect(() => transformHtml("<!-- site:onetimepass -->\n{{OPERATOR_NAME}}\n<!-- /site:onetimepass -->\n", { ...OPTS, profile: "onetimepass" })).toThrow();
  });
  it("selfhost: a placeholder outside any selfhost block is refused", () => {
    expect(() => transformHtml("<p>{{OPERATOR_NAME}}</p>\n", { ...OPTS, profile: "selfhost" })).toThrow();
  });
});

describe("real pages", () => {
  const pages = ["index.html", "privacy.html", "how-it-works.html", "command-line.html", "404.html"];
  for (const page of pages) {
    it(`${page}: both profiles transform cleanly`, () => {
      const source = readFileSync(join(ROOT, page), "utf8");
      const owner = transformHtml(source, { ...OPTS, profile: "onetimepass" });
      expect(owner).not.toMatch(/site:(?:onetimepass|selfhost)|\{\{/);
      const mine = transformHtml(source, { ...OPTS, profile: "selfhost", operatorName: "Op", operatorContact: "op@example.com" });
      expect(mine).not.toMatch(/site:(?:onetimepass|selfhost)|\{\{|onetimepass\.pages\.dev|googletagmanager|data-cookie-settings/i);
      expect(mine).not.toContain(OWNER_MAIL);
    });
  }
  it("how-it-works: the FAQ JSON-LD parses in both profiles", () => {
    const source = readFileSync(join(ROOT, "how-it-works.html"), "utf8");
    for (const profile of ["onetimepass", "selfhost"] as const) {
      const out = transformHtml(source, { ...OPTS, profile });
      const blocks = [...out.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
      expect(blocks.length).toBeGreaterThan(0);
      for (const b of blocks) JSON.parse(b[1]!);
    }
  });
});

describe("headersForSelfhost", () => {
  const source = readFileSync(join(ROOT, "public", "_headers"), "utf8");
  it("removes every Google host and every CSP override, keeps the rest", () => {
    const out = headersForSelfhost(source);
    expect(out).not.toMatch(/google|gtag/i);
    const first = out.indexOf("Content-Security-Policy:");
    expect(out.indexOf("Content-Security-Policy:", first + 1)).toBe(-1);
    expect(out).not.toContain("! Content-Security-Policy");
    expect(out).toContain("Strict-Transport-Security");
    expect(out).toContain("/assets/*\n  Cache-Control: public, max-age=31536000, immutable");
    expect(out).toContain("/how-it-works\n  Cache-Control: no-store\n");
  });
  it("leaves a file without overrides unchanged", () => {
    expect(headersForSelfhost("/*\n  A: b\n")).toBe("/*\n  A: b\n");
  });
});

describe("robots and sitemap", () => {
  const robots = readFileSync(join(ROOT, "public", "robots.txt"), "utf8");
  const sitemap = readFileSync(join(ROOT, "public", "sitemap.xml"), "utf8");
  it("default selfhost: Disallow all, no sitemap", () => {
    expect(robotsForSelfhost(robots, { origin: "https://my.host", indexable: false })).toBe("User-agent: *\nDisallow: /\n");
  });
  it("indexable: the original robots with the operator origin", () => {
    const out = robotsForSelfhost(robots, { origin: "https://my.host", indexable: true });
    expect(out).toContain("Sitemap: https://my.host/sitemap.xml");
    expect(out).toContain("Disallow: /api/");
    expect(out).not.toContain("pages.dev");
  });
  it("sitemap origin replaced", () => {
    const out = sitemapForSelfhost(sitemap, "https://my.host");
    expect(out).toContain("<loc>https://my.host/</loc>");
    expect(out).not.toContain("pages.dev");
  });
});
