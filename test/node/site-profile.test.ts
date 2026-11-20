import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  securityTxtForPages,
  securityTxtForSelfhost,
  applyBlocks,
  headersForSelfhost,
  headersForInfo,
  INFO_CSP,
  INFO_ORIGIN,
  OWNER_ORIGIN,
  redirectsForApp,
  redirectsForInfo,
  rewriteLinks,
  robotsForInfo,
  sitemapForSite,
  dropManifestLink,
  operatorContactHtml,
  operatorNameHtml,
  parseOrigin,
  robotsForSelfhost,
  sitemapForSelfhost,
  transformHtml,
} from "../../tools/site-profile-core.mjs";
import { inputsFor, readProfileEnv, siteProfile } from "../../tools/site-profile.mjs";
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
    expect(out).toContain("Permissions-Policy:");
    expect(out).toContain("Cross-Origin-Resource-Policy: same-origin");
    expect(out).toContain("/assets/*\n  Cache-Control: public, max-age=31536000, immutable");
    expect(out).toContain("/how-it-works\n  Cache-Control: no-store\n");
  });
  it("indexable: leaves a file without overrides unchanged", () => {
    expect(headersForSelfhost("/*\n  A: b\n", { indexable: true })).toBe("/*\n  A: b\n");
  });
  it("not indexable: X-Robots-Tag: noindex once, in the /* rule, so every response with rule headers carries it", () => {
    expect(headersForSelfhost("/*\n  A: b\n", { indexable: false })).toBe("/*\n  X-Robots-Tag: noindex\n  A: b\n");
    const out = headersForSelfhost(source, { indexable: false });
    expect(out.match(/^[ \t]+X-Robots-Tag:/gm)).toHaveLength(1);
    expect(out).toMatch(/^\/\*\n {2}X-Robots-Tag: noindex\n/m);
    expect(out).not.toContain("/cli/*");
    expect(out.endsWith("\n") && !out.endsWith("\n\n")).toBe(true);
  });
  it("indexable keeps the original rule on /cli/* only", () => {
    const out = headersForSelfhost(source, { indexable: true });
    expect(out.match(/^[ \t]+X-Robots-Tag:/gm)).toHaveLength(1);
    expect(out).toContain("/cli/*\n  X-Robots-Tag: noindex");
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

describe("security.txt", () => {
  const now = new Date("2026-11-20T10:11:12.345Z");
  const privacy = '<p>Contact: <a href="mailto:owner@pages.example">owner@pages.example</a>.</p>';
  it("pages: advisory URL, the published address, Expires about 11 months ahead, canonical, policy, languages", () => {
    const out = securityTxtForPages({ privacyHtml: privacy, now })!;
    expect(out.endsWith("\n")).toBe(true);
    const lines = out.trimEnd().split("\n");
    expect(lines).toContain("Contact: https://github.com/devopsacid/onetime/security/advisories/new");
    expect(lines).toContain("Contact: mailto:owner@pages.example");
    expect(lines).toContain("Expires: 2027-10-20T10:11:12Z");
    expect(lines).toContain("Canonical: https://onetimepass.pages.dev/.well-known/security.txt");
    expect(lines).toContain("Policy: https://github.com/devopsacid/onetime/blob/main/SECURITY.md");
    expect(lines).toContain("Preferred-Languages: en, sk");
  });
  it("pages: throws when privacy.html has no mailto address", () => {
    expect(() => securityTxtForPages({ privacyHtml: "<p>none</p>", now })).toThrow(/mailto/);
  });
  it("selfhost: operator email becomes mailto, https URL stays, canonical from the origin, no owner data", () => {
    const mail = securityTxtForSelfhost({ origin: "https://my.host", contact: "sec@my.host", now })!;
    expect(mail).toContain("Contact: mailto:sec@my.host\n");
    expect(mail).toContain("Canonical: https://my.host/.well-known/security.txt\n");
    expect(mail).toContain("Expires: 2027-10-20T10:11:12Z\n");
    const url = securityTxtForSelfhost({ origin: "https://my.host", contact: "https://my.host/report", now })!;
    expect(url).toContain("Contact: https://my.host/report\n");
    for (const out of [mail, url]) expect(out).not.toMatch(/devopsacid|onetimepass|maxian/);
  });
  it("selfhost: no contact gives no file; a bad contact throws", () => {
    expect(securityTxtForSelfhost({ origin: "https://my.host", contact: undefined, now })).toBeNull();
    expect(securityTxtForSelfhost({ origin: "https://my.host", contact: "", now })).toBeNull();
    expect(() => securityTxtForSelfhost({ origin: "https://my.host", contact: "nonsense", now })).toThrow();
  });
});

describe("siteProfile plugin config", () => {
  type Cfg = { define: Record<string, string>; build: { outDir: string; rollupOptions: { input: Record<string, string> } } };
  const configFor = (env: Record<string, string>) => {
    const plugin = siteProfile(env) as unknown as { config(c: { root?: string }): Cfg };
    return plugin.config({ root: ROOT });
  };
  const SELF = { ONETIME_SITE: "selfhost", ONETIME_ORIGIN: "https://my.host" };
  it("defines __SITE__ per profile (analytics code is reachable only in the info profile)", () => {
    expect(configFor({}).define).toEqual({ __SITE__: '"app"' });
    expect(configFor({ ONETIME_SITE: "onetimepass" }).define).toEqual({ __SITE__: '"app"' });
    expect(configFor({ ONETIME_SITE: "info" }).define).toEqual({ __SITE__: '"info"' });
    expect(configFor(SELF).define).toEqual({ __SITE__: '"selfhost"' });
    expect(configFor({ ...SELF, ONETIME_INDEXABLE: "1" }).define).toEqual({ __SITE__: '"selfhost"' });
  });
  it("writes app to dist, info to dist-info and self-host to dist-selfhost", () => {
    expect(configFor({}).build.outDir).toBe("dist");
    expect(configFor({ ONETIME_SITE: "info" }).build.outDir).toBe("dist-info");
    expect(configFor(SELF).build.outDir).toBe("dist-selfhost");
  });
  it("takes the inputs from the profile", () => {
    expect(configFor({}).build.rollupOptions.input).toEqual(inputsFor("onetimepass"));
    expect(configFor({ ONETIME_SITE: "info" }).build.rollupOptions.input).toEqual(inputsFor("info"));
  });
  it("rejects an unknown profile and accepts info without an origin", () => {
    expect(readProfileEnv({ ONETIME_SITE: "info" })).toEqual({ profile: "info", outDir: "dist-info" });
    expect(() => readProfileEnv({ ONETIME_SITE: "other" })).toThrow();
  });
});

describe("inputsFor", () => {
  it("app: index, command-line, 404", () => {
    expect(inputsFor("onetimepass")).toEqual({ main: "index.html", commandLine: "command-line.html", notFound: "404.html" });
  });
  it("info: how-it-works, privacy, 404", () => {
    expect(inputsFor("info")).toEqual({ howItWorks: "how-it-works.html", privacy: "privacy.html", notFound: "404.html" });
  });
  it("selfhost: all five pages", () => {
    expect(Object.values(inputsFor("selfhost")).sort()).toEqual(["404.html", "command-line.html", "how-it-works.html", "index.html", "privacy.html"]);
  });
});

describe("origins", () => {
  it("are fixed and neither contains the other", () => {
    expect(OWNER_ORIGIN).toBe("https://onetimepass.pages.dev");
    expect(INFO_ORIGIN).toBe("https://onetimepass-info.pages.dev");
    expect(INFO_ORIGIN.includes(OWNER_ORIGIN)).toBe(false);
    expect(OWNER_ORIGIN.includes(INFO_ORIGIN)).toBe(false);
  });
});

describe("rewriteLinks", () => {
  const a = (href: string, extra = "") => `<a class="x" href="${href}"${extra}>t</a>`;
  it("app profile: info-home paths become absolute info links, fragment and query kept", () => {
    expect(rewriteLinks(a("/how-it-works"), "onetimepass")).toBe(a(`${INFO_ORIGIN}/how-it-works`));
    expect(rewriteLinks(a("/privacy#cookies"), "onetimepass")).toBe(a(`${INFO_ORIGIN}/privacy#cookies`));
    expect(rewriteLinks(a("/how-it-works?x=1#server"), "onetimepass")).toBe(a(`${INFO_ORIGIN}/how-it-works?x=1#server`));
  });
  it("app profile: app-home paths, assets, fragments and absolute links stay", () => {
    for (const href of ["/", "/command-line", "/cli/onetime.mjs", "/cli/", "#top", "/favicon.svg", "https://example.org/", "mailto:a@b.example", "/#x"]) {
      expect(rewriteLinks(a(href), "onetimepass")).toBe(a(href));
    }
  });
  it("info profile: app-home paths become absolute app links, fragment kept", () => {
    expect(rewriteLinks(a("/"), "info")).toBe(a(`${OWNER_ORIGIN}/`));
    expect(rewriteLinks(a("/command-line"), "info")).toBe(a(`${OWNER_ORIGIN}/command-line`));
    expect(rewriteLinks(a("/cli/onetime.mjs"), "info")).toBe(a(`${OWNER_ORIGIN}/cli/onetime.mjs`));
    expect(rewriteLinks(a("/cli/"), "info")).toBe(a(`${OWNER_ORIGIN}/cli/`));
    expect(rewriteLinks(a("/#abc"), "info")).toBe(a(`${OWNER_ORIGIN}/#abc`));
  });
  it("info profile: info-home paths and fragments stay", () => {
    for (const href of ["/how-it-works", "/privacy#cookies", "#faq", "/privacy"]) expect(rewriteLinks(a(href), "info")).toBe(a(href));
  });
  it("handles single quotes, other attributes after href and several links", () => {
    expect(rewriteLinks("<a href='/privacy' download>p</a> <a href=\"/\">h</a>", "onetimepass")).toBe(`<a href='${INFO_ORIGIN}/privacy' download>p</a> <a href="/">h</a>`);
  });
  it("rewrites only <a href>: other tags and attributes are untouched", () => {
    const html = '<link rel="canonical" href="/privacy"><img src="/privacy"><area href="/privacy"><script src="/privacy"></script>';
    expect(rewriteLinks(html, "onetimepass")).toBe(html);
    expect(rewriteLinks('<abbr title="x" href="/privacy">', "onetimepass")).toBe('<abbr title="x" href="/privacy">');
  });
  it("does not touch protocol-relative links or unknown root paths", () => {
    expect(rewriteLinks(a("//privacy"), "onetimepass")).toBe(a("//privacy"));
    expect(rewriteLinks(a("/privacy.html"), "onetimepass")).toBe(a("/privacy.html"));
    expect(rewriteLinks(a("/privacyx"), "onetimepass")).toBe(a("/privacyx"));
  });
  it("selfhost is refused here (the caller must not rewrite)", () => {
    expect(() => rewriteLinks(a("/privacy"), "selfhost" as never)).toThrow();
  });
});

describe("transformHtml with three profiles", () => {
  const html = '<link rel="manifest" href="/manifest.webmanifest" />\n<a href="/privacy">p</a> <a href="/">h</a> https://onetimepass-info.pages.dev/x https://onetimepass.pages.dev/y\n';
  it("app: rewrites links, keeps the manifest line", () => {
    const out = transformHtml(html, { ...OPTS, profile: "onetimepass" });
    expect(out).toContain(`<a href="${INFO_ORIGIN}/privacy">`);
    expect(out).toContain('<a href="/">');
    expect(out).toContain('rel="manifest"');
  });
  it("info: rewrites links, drops the manifest link line", () => {
    const out = transformHtml(html, { ...OPTS, profile: "info" });
    expect(out).toContain('<a href="/privacy">');
    expect(out).toContain(`<a href="${OWNER_ORIGIN}/">`);
    expect(out).not.toContain("manifest");
  });
  it("selfhost: links untouched, both origins replaced", () => {
    const out = transformHtml(html, { ...OPTS, profile: "selfhost" });
    expect(out).toContain('<a href="/privacy">p</a> <a href="/">h</a>');
    expect(out).toContain("https://my.host/x https://my.host/y");
    expect(out).not.toMatch(/pages\.dev/);
  });
  it("dropManifestLink removes only the manifest link", () => {
    expect(dropManifestLink('<a>\n    <link rel="manifest" href="/manifest.webmanifest" />\n<b>\n')).toBe("<a>\n<b>\n");
    expect(dropManifestLink('<link rel="icon" href="/x">\n')).toBe('<link rel="icon" href="/x">\n');
  });
});

describe("headersForInfo", () => {
  const sample = [
    "/*",
    "  Content-Security-Policy: default-src 'none'; script-src 'self'",
    "  Referrer-Policy: no-referrer",
    "",
    "# comment of the root",
    "/",
    "  Cache-Control: no-store",
    "",
    "/index.html",
    "  Cache-Control: no-store",
    "",
    "/command-line",
    "  Cache-Control: no-store",
    "",
    "/command-line.html",
    "  Cache-Control: no-store",
    "",
    "/how-it-works",
    "  Cache-Control: no-store",
    "",
    "/assets/*",
    "  Cache-Control: public, max-age=31536000, immutable",
    "",
    "# Downloads",
    "/cli/*",
    "  X-Robots-Tag: noindex",
    "",
  ].join("\n");
  const out = headersForInfo(sample);
  it("replaces the /* CSP with INFO_CSP, once", () => {
    expect(out.match(/Content-Security-Policy:/g)).toHaveLength(1);
    expect(out).toContain(`/*\n  Content-Security-Policy: ${INFO_CSP}\n  Referrer-Policy: no-referrer\n`);
  });
  it("drops the app-only rules, with the comment lines above them", () => {
    for (const rule of ["/", "/index.html", "/command-line", "/command-line.html", "/cli/*"]) expect(out.split("\n")).not.toContain(rule);
    expect(out).not.toMatch(/comment of the root|Downloads|X-Robots-Tag/);
  });
  it("keeps the other rules and the other /* headers", () => {
    expect(out).toContain("/how-it-works\n  Cache-Control: no-store");
    expect(out).toContain("/assets/*\n  Cache-Control: public, max-age=31536000, immutable");
    expect(out.endsWith("\n") && !out.endsWith("\n\n")).toBe(true);
  });
  it("INFO_CSP is the Google policy: GA hosts, nothing inline", () => {
    expect(INFO_CSP).toContain("script-src 'self' https://www.googletagmanager.com;");
    expect(INFO_CSP).not.toContain("unsafe-inline");
    expect(INFO_CSP.startsWith("default-src 'none';")).toBe(true);
  });
  it("throws when there is no /* CSP to replace", () => {
    expect(() => headersForInfo("/*\n  A: b\n")).toThrow();
  });
});

describe("redirects, robots, sitemap for the sites", () => {
  it("app _redirects: exactly the six old info URLs, 301, never / or /index.html", () => {
    expect(redirectsForApp()).toBe(
      [
        `/how-it-works https://onetimepass-info.pages.dev/how-it-works 301`,
        `/how-it-works.html https://onetimepass-info.pages.dev/how-it-works 301`,
        `/how-it-works/ https://onetimepass-info.pages.dev/how-it-works 301`,
        `/privacy https://onetimepass-info.pages.dev/privacy 301`,
        `/privacy.html https://onetimepass-info.pages.dev/privacy 301`,
        `/privacy/ https://onetimepass-info.pages.dev/privacy 301`,
        "",
      ].join("\n"),
    );
  });
  it("info _redirects: / and the app pages and /cli/* go to the app", () => {
    expect(redirectsForInfo()).toBe(
      [
        `/ https://onetimepass.pages.dev/ 301`,
        `/index.html https://onetimepass.pages.dev/ 301`,
        `/command-line https://onetimepass.pages.dev/command-line 301`,
        `/command-line.html https://onetimepass.pages.dev/command-line 301`,
        `/cli/* https://onetimepass.pages.dev/cli/:splat 301`,
        "",
      ].join("\n"),
    );
  });
  it("info robots.txt", () => {
    expect(robotsForInfo()).toBe("User-agent: *\nAllow: /\n\nSitemap: https://onetimepass-info.pages.dev/sitemap.xml\n");
  });
  const sitemap = [
    "<urlset>",
    `  <url>\n    <loc>${OWNER_ORIGIN}/</loc>\n    <lastmod>2026-11-20</lastmod>\n  </url>`,
    `  <url>\n    <loc>${INFO_ORIGIN}/how-it-works</loc>\n    <lastmod>2026-11-20</lastmod>\n  </url>`,
    `  <url>\n    <loc>${OWNER_ORIGIN}/command-line</loc>\n    <lastmod>2026-11-19</lastmod>\n  </url>`,
    `  <url>\n    <loc>${INFO_ORIGIN}/privacy</loc>\n    <lastmod>2026-11-19</lastmod>\n  </url>`,
    "</urlset>",
    "",
  ].join("\n");
  it("sitemapForSite keeps only the entries of one origin", () => {
    const app = sitemapForSite(sitemap, OWNER_ORIGIN);
    expect(app).toContain(`${OWNER_ORIGIN}/</loc>`);
    expect(app).toContain(`${OWNER_ORIGIN}/command-line</loc>`);
    expect(app).not.toContain("onetimepass-info");
    expect(app.startsWith("<urlset>") && app.endsWith("</urlset>\n")).toBe(true);
    const info = sitemapForSite(sitemap, INFO_ORIGIN);
    expect(info).toContain(`${INFO_ORIGIN}/how-it-works</loc>`);
    expect(info).toContain(`${INFO_ORIGIN}/privacy</loc>`);
    expect(info.match(/<url>/g)).toHaveLength(2);
    expect(info).not.toContain(`${OWNER_ORIGIN}/`);
  });
  it("sitemapForSelfhost replaces both origins", () => {
    const out = sitemapForSelfhost(sitemap, "https://my.host");
    expect(out).not.toContain("pages.dev");
    expect(out.match(/https:\/\/my\.host\//g)).toHaveLength(4);
  });
  it("security.txt is generated per origin", () => {
    const out = securityTxtForPages({ privacyHtml: '<a href="mailto:o@example.org">o</a>', now: new Date("2026-11-20T00:00:00Z"), origin: INFO_ORIGIN });
    expect(out).toContain(`Canonical: ${INFO_ORIGIN}/.well-known/security.txt`);
  });
});
