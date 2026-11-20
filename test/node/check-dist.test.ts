import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { headersForInfo, headersForSelfhost, INFO_CSP, redirectsForApp, redirectsForInfo, securityTxtForPages } from "../../tools/site-profile-core.mjs";
import { PUBLIC_HEADERS, ROOT, tempDir } from "./helpers";

const ORIGIN = "https://onetime.example";
const APP = "https://onetimepass.pages.dev";
const INFO = "https://onetimepass-info.pages.dev";
type Profile = "selfhost" | "app" | "info";
const ownOrigin = (profile: Profile) => ({ selfhost: ORIGIN, app: APP, info: INFO })[profile];
const page = (origin: string, extra = "") =>
  `<!doctype html>\n<html><head><script src="/theme-init.js"></script><link rel="stylesheet" href="/assets/a.css"><script type="module" src="/assets/a.js"></script></head><body><a href="${origin}/">home</a>${extra}</body></html>\n`;

/** A minimal dist for each profile. */
const profiles = new Map<string, Profile>();
function fixture(root: string, profile: Profile): string {
  const dir = join(root, "d");
  profiles.set(dir, profile);
  mkdirSync(join(dir, "assets"), { recursive: true });
  const names = { selfhost: ["index", "404", "how-it-works", "command-line", "privacy"], app: ["index", "404", "command-line"], info: ["404", "how-it-works", "privacy"] }[profile];
  for (const name of names) writeFileSync(join(dir, `${name}.html`), page(ownOrigin(profile)));
  writeFileSync(join(dir, "theme-init.js"), "document.documentElement.dataset.theme='light'\n");
  writeFileSync(join(dir, "assets", "a.js"), "console.log('app')\n");
  writeFileSync(join(dir, "assets", "a.css"), "body{}\n");
  const headers = readFileSync(PUBLIC_HEADERS, "utf8");
  if (profile !== "info") {
    writeFileSync(join(dir, "manifest.webmanifest"), "{}\n");
    writeFileSync(join(dir, "_routes.json"), '{"version":1}\n');
  }
  if (profile === "selfhost") {
    writeFileSync(join(dir, "_headers"), headersForSelfhost(headers));
    writeFileSync(join(dir, "_selfhost.json"), JSON.stringify({ origin: ORIGIN }));
    return dir;
  }
  mkdirSync(join(dir, ".well-known"), { recursive: true });
  writeFileSync(join(dir, ".well-known", "security.txt"), securityTxtForPages({ privacyHtml: '<a href="mailto:o@example.org">o</a>', now: new Date(), origin: ownOrigin(profile) })!);
  if (profile === "app") {
    mkdirSync(join(dir, "cli"), { recursive: true });
    writeFileSync(join(dir, "cli", "onetime.mjs"), "// cli\n");
    writeFileSync(join(dir, "_headers"), headers);
    writeFileSync(join(dir, "_redirects"), redirectsForApp());
  } else {
    writeFileSync(join(dir, "_headers"), headersForInfo(headers));
    writeFileSync(join(dir, "_redirects"), redirectsForInfo());
  }
  return dir;
}

const SELF_TXT = `Contact: mailto:sec@onetime.example\nExpires: ${new Date(Date.now() + 330 * 864e5).toISOString().slice(0, 19)}Z\nCanonical: ${ORIGIN}/.well-known/security.txt\n`;
const writeTxt = (dir: string, text: string) => {
  mkdirSync(join(dir, ".well-known"), { recursive: true });
  writeFileSync(join(dir, ".well-known", "security.txt"), text);
};

function check(dir: string): { code: number | null; out: string } {
  const flag = profiles.get(dir) === "info" ? ["--profile", "info"] : [];
  const r = spawnSync(process.execPath, [join(ROOT, "tools", "check-dist.mjs"), dir, ...flag], { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const faqPage = (origin: string, ld: Array<[string, string]>, visible: Array<[string, string]>) => {
  const entity = ld.map(([name, text]) => ({ "@type": "Question", name, acceptedAnswer: { "@type": "Answer", text } }));
  const json = JSON.stringify({ "@context": "https://schema.org", "@graph": [{ "@type": "FAQPage", mainEntity: entity }] });
  const details = visible.map(([q, a]) => `<details><summary>${q}</summary>\n<p>\n  ${a}\n</p></details>`).join("\n");
  return page(origin, `<script type="application/ld+json">${json}</script><section id="faq"><div class="faq">${details}</div></section>`);
};

describe("check-dist FAQ equality", () => {
  let tmp: ReturnType<typeof tempDir>;
  beforeEach(() => {
    tmp = tempDir("check-dist-faq-");
  });
  afterEach(() => tmp.remove());
  const qa: Array<[string, string]> = [["Can you read it?", "No. The key is after <code>#</code>."]];
  const plain: Array<[string, string]> = [["Can you read it?", "No. The key is after #."]];

  it.each(["selfhost", "info"] as const)("%s: a matching FAQ (whitespace and tags normalised) passes", (profile) => {
    const dir = fixture(tmp.path, profile);
    writeFileSync(join(dir, "how-it-works.html"), faqPage(ownOrigin(profile), plain, qa));
    expect(check(dir).code).toBe(0);
  });
  it.each(["selfhost", "info"] as const)("%s: a JSON-LD answer that differs from the visible one fails", (profile) => {
    const dir = fixture(tmp.path, profile);
    writeFileSync(join(dir, "how-it-works.html"), faqPage(ownOrigin(profile), [["Can you read it?", "Yes."]], qa));
    const r = check(dir);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAQ/);
  });
  it("a JSON-LD question missing from the visible FAQ fails", () => {
    const dir = fixture(tmp.path, "info");
    writeFileSync(join(dir, "how-it-works.html"), faqPage(INFO, [...plain, ["Extra?", "Hidden."]], qa));
    expect(check(dir).code).toBe(1);
  });
});

describe("check-dist profiles", () => {
  let tmp: ReturnType<typeof tempDir>;
  beforeEach(() => {
    tmp = tempDir("check-dist-");
  });
  afterEach(() => tmp.remove());

  it("selfhost: a clean fixture passes", () => {
    const r = check(fixture(tmp.path, "selfhost"));
    expect(r.out).toContain("OK");
    expect(r.code).toBe(0);
  });
  it("app: a clean fixture passes", () => {
    const r = check(fixture(tmp.path, "app"));
    expect(r.out).toContain("OK");
    expect(r.code).toBe(0);
  });
  it("selfhost: a GA measurement ID in a script fails", () => {
    const dir = fixture(tmp.path, "selfhost");
    writeFileSync(join(dir, "assets", "other.js"), 'const id = "G-W3GR41J2NR";\n');
    const r = check(dir);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/G-W3GR41J2NR/);
  });
  it("selfhost: gtag anywhere in the dist fails, also outside index.html's reach", () => {
    const dir = fixture(tmp.path, "selfhost");
    writeFileSync(join(dir, "assets", "unlinked.js"), "function gtag(){}\n");
    expect(check(dir).code).toBe(1);
  });
  it.each(["selfhost", "app", "info"] as const)("%s: a /* rule without Permissions-Policy or CORP fails", (profile) => {
    for (const name of ["Permissions-Policy", "Cross-Origin-Resource-Policy"]) {
      const dir = fixture(tmp.path, profile);
      const text = readFileSync(join(dir, "_headers"), "utf8");
      writeFileSync(join(dir, "_headers"), text.split("\n").filter((l) => !l.trim().startsWith(`${name}:`)).join("\n"));
      const r = check(dir);
      expect(r.code).toBe(1);
      expect(r.out).toContain(name);
    }
  });
  it.each(["selfhost", "app", "info"] as const)("%s: a Permissions-Policy that allows the camera or drops clipboard-write fails", (profile) => {
    for (const [from, to] of [["camera=()", "camera=*"], ["clipboard-write=(self)", "clipboard-write=()"]]) {
      const dir = fixture(tmp.path, profile);
      writeFileSync(join(dir, "_headers"), readFileSync(join(dir, "_headers"), "utf8").replace(from!, to!));
      expect(check(dir).code).toBe(1);
    }
  });
  it("selfhost: a leftover marker fails", () => {
    const dir = fixture(tmp.path, "selfhost");
    writeFileSync(join(dir, "privacy.html"), page(ORIGIN, "<!-- site:selfhost -->"));
    const r = check(dir);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/marker/);
  });
  it("pages: a leftover marker fails", () => {
    const dir = fixture(tmp.path, "app");
    writeFileSync(join(dir, "command-line.html"), page(APP, "<!-- /site:onetimepass -->"));
    expect(check(dir).code).toBe(1);
  });
  it("selfhost: a leftover placeholder fails", () => {
    const dir = fixture(tmp.path, "selfhost");
    writeFileSync(join(dir, "privacy.html"), page(ORIGIN, "<p>{{OPERATOR_NAME}}</p>"));
    expect(check(dir).code).toBe(1);
  });
  it("selfhost: a Google CSP in _headers fails", () => {
    const dir = fixture(tmp.path, "selfhost");
    writeFileSync(join(dir, "_headers"), headersForInfo(readFileSync(PUBLIC_HEADERS, "utf8")));
    const r = check(dir);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/_headers/);
  });
  it("selfhost: the owner's origin or address outside cli/ fails, inside cli/ the project URL is allowed", () => {
    const dir = fixture(tmp.path, "selfhost");
    mkdirSync(join(dir, "cli"), { recursive: true });
    writeFileSync(join(dir, "cli", "onetime.mjs"), "// https://onetimepass.pages.dev\n");
    expect(check(dir).code).toBe(0);
    writeFileSync(join(dir, "robots.txt"), "Sitemap: https://onetimepass.pages.dev/sitemap.xml\n");
    expect(check(dir).code).toBe(1);
    writeFileSync(join(dir, "robots.txt"), `contact ${["michal", "maxian.sk"].join("@")}\n`);
    expect(check(dir).code).toBe(1);
  });
  it("selfhost: an external resource is judged against the selfhost origin", () => {
    const dir = fixture(tmp.path, "selfhost");
    writeFileSync(join(dir, "privacy.html"), page(ORIGIN, '<img src="https://onetimepass.pages.dev/x.png">'));
    expect(check(dir).code).toBe(1);
  });
  it("pages: a stray _selfhost.json fails", () => {
    const dir = fixture(tmp.path, "app");
    writeFileSync(join(dir, "_selfhost.json"), "{}");
    // a present _selfhost.json switches to selfhost mode; the pages-only content must then fail there
    expect(check(dir).code).toBe(1);
  });
  it("selfhost: an invalid _selfhost.json fails", () => {
    const dir = fixture(tmp.path, "selfhost");
    writeFileSync(join(dir, "_selfhost.json"), "{");
    expect(check(dir).code).toBe(1);
    rmSync(join(dir, "_selfhost.json"));
  });

  describe("security.txt", () => {
    it("selfhost: absent is fine, an operator file passes", () => {
      const dir = fixture(tmp.path, "selfhost");
      expect(check(dir).code).toBe(0);
      writeTxt(dir, SELF_TXT);
      expect(check(dir).code).toBe(0);
    });
    it("selfhost: the owner's address or the original advisory URL fails", () => {
      for (const leak of [`Contact: mailto:${["michal", "maxian.sk"].join("@")}\n`, "Contact: https://github.com/devopsacid/onetime/security/advisories/new\n"]) {
        const dir = fixture(tmp.path, "selfhost");
        writeTxt(dir, SELF_TXT + leak);
        const r = check(dir);
        expect(r.code).toBe(1);
        expect(r.out).toMatch(/security\.txt|owner|devopsacid/);
        rmSync(dir, { recursive: true });
      }
    });
    it("pages: missing file fails", () => {
      const dir = fixture(tmp.path, "app");
      rmSync(join(dir, ".well-known"), { recursive: true });
      const r = check(dir);
      expect(r.code).toBe(1);
      expect(r.out).toContain("security.txt");
    });
    it.each(["selfhost", "app", "info"] as const)("%s: Expires missing, past, under 30 days or over a year fails", (profile) => {
      const base = (expires: string) => `Contact: mailto:sec@example.org\n${expires}Canonical: ${ownOrigin(profile)}/.well-known/security.txt\n`;
      const iso = (days: number) => `Expires: ${new Date(Date.now() + days * 864e5).toISOString().slice(0, 19)}Z\n`;
      for (const text of [base(""), base(iso(-1)), base(iso(29)), base(iso(400)), base("Expires: soon\n")]) {
        const dir = fixture(tmp.path, profile);
        writeTxt(dir, text);
        const r = check(dir);
        expect([text, r.code]).toEqual([text, 1]);
        expect(r.out).toContain("Expires");
        rmSync(dir, { recursive: true });
      }
      const dir = fixture(tmp.path, profile);
      writeTxt(dir, base(iso(31)));
      expect(check(dir).code).toBe(0);
    });
    it("a file without Contact or with a wrong Canonical fails", () => {
      const dir = fixture(tmp.path, "selfhost");
      writeTxt(dir, "Expires: 2099-01-01T00:00:00Z\n");
      expect(check(dir).code).toBe(1);
      writeTxt(dir, SELF_TXT.replace(ORIGIN, "https://elsewhere.example"));
      const r = check(dir);
      expect(r.code).toBe(1);
      expect(r.out).toContain("Canonical");
    });
  });
});

describe("check-dist rules per profile", () => {
  let tmp: ReturnType<typeof tempDir>;
  beforeEach(() => {
    tmp = tempDir("check-dist-split-");
  });
  afterEach(() => tmp.remove());
  const put = (dir: string, name: string, text: string) => {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  };
  const failsWith = (dir: string, pattern: RegExp) => {
    const r = check(dir);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(pattern);
  };

  it("info: a clean fixture passes and the profile is reported", () => {
    const r = check(fixture(tmp.path, "info"));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/info profile/);
  });
  it("without the flag an info dist is not accepted (content rules of the app apply)", () => {
    const dir = fixture(tmp.path, "info");
    profiles.set(dir, "app");
    expect(check(dir).code).toBe(1);
  });

  describe("1: _headers", () => {
    it("app: a second CSP line, the INFO_CSP in /*, or a detach line fails", () => {
      const base = readFileSync(PUBLIC_HEADERS, "utf8");
      const cases = [
        base.replace("/privacy\n", `/privacy\n  Content-Security-Policy: ${INFO_CSP}\n`),
        base.replace(/(\/\*\n {2})Content-Security-Policy: [^\n]*/, `$1Content-Security-Policy: ${INFO_CSP}`),
        base.replace("/privacy\n", "/privacy\n  ! Content-Security-Policy\n"),
      ];
      for (const text of cases) {
        const dir = fixture(tmp.path, "app");
        put(dir, "_headers", text);
        failsWith(dir, /_headers/);
        rmSync(dir, { recursive: true });
      }
    });
    it("info: the strict CSP in /* fails (the info site needs INFO_CSP) and so does a second CSP line", () => {
      const dir = fixture(tmp.path, "info");
      put(dir, "_headers", readFileSync(PUBLIC_HEADERS, "utf8"));
      failsWith(dir, /_headers/);
      put(dir, "_headers", `${headersForInfo(readFileSync(PUBLIC_HEADERS, "utf8"))}\n/privacy\n  Content-Security-Policy: ${INFO_CSP}\n`);
      failsWith(dir, /_headers/);
    });
    it("the app CSP in public/_headers is exactly the strict policy, with no blob: and no data:", () => {
      // Hard-coded on purpose: files are saved through <a download>, which needs no CSP change (docs/plans/file-transfer.md A-8).
      const strict =
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
      const headers = readFileSync(PUBLIC_HEADERS, "utf8");
      const lines = headers.split("\n").filter((l) => /content-security-policy/i.test(l));
      expect(lines).toEqual([`  Content-Security-Policy: ${strict}`]);
      expect(headers).not.toMatch(/blob:|data:/i);
    });
    it.each(["blob:", "data:"] as const)("every profile: %s in a CSP directive fails with its own message", (scheme) => {
      for (const profile of ["app", "info", "selfhost"] as const) {
        const dir = fixture(tmp.path, profile);
        const headers = readFileSync(join(dir, "_headers"), "utf8");
        put(dir, "_headers", headers.replace(/(Content-Security-Policy: [^\n]*img-src 'self')/, `$1 ${scheme}`));
        failsWith(dir, new RegExp(`CSP .*${scheme}`));
        rmSync(dir, { recursive: true });
      }
    });
    it("a blob: or data: source in a second place (connect-src, a rule for one path) fails too", () => {
      const dir = fixture(tmp.path, "app");
      const headers = readFileSync(join(dir, "_headers"), "utf8");
      put(dir, "_headers", headers.replace("connect-src 'self'", "connect-src 'self' blob:"));
      failsWith(dir, /CSP .*blob:/);
      put(dir, "_headers", `${headers}\n/privacy\n  X-Test: data:text/html,hi\n`);
      failsWith(dir, /data:/);
    });
    it("a missing _headers fails", () => {
      const dir = fixture(tmp.path, "info");
      rmSync(join(dir, "_headers"));
      failsWith(dir, /_headers/);
    });
  });

  describe("2: analytics strings", () => {
    it.each(["gtag", "googletagmanager", "google-analytics", "analytics.google", "G-W3GR41J2NR"])("app: %s in any file, even an unlinked one, fails", (word) => {
      for (const file of ["assets/unlinked.js", "notes.txt", "cli/onetime.mjs", "robots.txt"]) {
        const dir = fixture(tmp.path, "app");
        put(dir, file, `// ${word}\n`);
        failsWith(dir, new RegExp(word.replace(/\./g, "\\.")));
        rmSync(dir, { recursive: true });
      }
    });
    it("info: gtag in a chunk loaded by 404.html fails; in an unlinked file or a page chunk it is allowed", () => {
      const dir = fixture(tmp.path, "info");
      put(dir, "assets/unlinked.js", "function gtag(){}\n");
      expect(check(dir).code).toBe(0);
      put(dir, "assets/a.js", "function gtag(){}\n");
      failsWith(dir, /gtag/);
    });
  });

  describe("3: which files exist", () => {
    it("app: how-it-works.html or privacy.html present fails; a missing page or cli/ fails", () => {
      for (const name of ["how-it-works.html", "privacy.html"]) {
        const dir = fixture(tmp.path, "app");
        put(dir, name, page(APP));
        failsWith(dir, new RegExp(name.replace(".", "\\.")));
        rmSync(dir, { recursive: true });
      }
      for (const name of ["index.html", "command-line.html", "404.html", "cli"]) {
        const dir = fixture(tmp.path, "app");
        rmSync(join(dir, name), { recursive: true });
        failsWith(dir, new RegExp(name.replace(".", "\\.")));
        rmSync(dir, { recursive: true });
      }
    });
    it("info: index.html, command-line.html, cli/, _routes.json or manifest.webmanifest present fails; a missing page fails", () => {
      for (const name of ["index.html", "command-line.html", "cli/onetime.mjs", "_routes.json", "manifest.webmanifest"]) {
        const dir = fixture(tmp.path, "info");
        put(dir, name, name.endsWith(".html") ? page(INFO) : "{}\n");
        failsWith(dir, new RegExp(name.split("/")[0]!.replace(".", "\\.")));
        rmSync(dir, { recursive: true });
      }
      for (const name of ["how-it-works.html", "privacy.html", "404.html"]) {
        const dir = fixture(tmp.path, "info");
        rmSync(join(dir, name));
        failsWith(dir, new RegExp(name.replace(".", "\\.")));
        rmSync(dir, { recursive: true });
      }
    });
    it("info: a _worker.js file or directory (advanced-mode Worker) fails", () => {
      for (const name of ["_worker.js", "_worker.js/index.js"]) {
        const dir = fixture(tmp.path, "info");
        put(dir, name, "export default {};\n");
        failsWith(dir, /_worker\.js/);
        rmSync(dir, { recursive: true });
      }
    });
    it("selfhost: a _redirects file or a missing page fails", () => {
      let dir = fixture(tmp.path, "selfhost");
      put(dir, "_redirects", redirectsForApp());
      failsWith(dir, /_redirects/);
      rmSync(dir, { recursive: true });
      dir = fixture(tmp.path, "selfhost");
      rmSync(join(dir, "privacy.html"));
      failsWith(dir, /privacy\.html/);
    });
  });

  describe("4: root-relative links", () => {
    it.each(["app", "info", "selfhost"] as const)("%s: a link to a file that is not in the build fails", (profile) => {
      const dir = fixture(tmp.path, profile);
      const pageName = profile === "info" ? "privacy.html" : "404.html";
      put(dir, pageName, page(ownOrigin(profile), '<a href="/nowhere">x</a>'));
      failsWith(dir, /\/nowhere/);
    });
    it("app: a root-relative link to a page of the info site (not rewritten) fails", () => {
      const dir = fixture(tmp.path, "app");
      put(dir, "404.html", page(APP, '<a href="/privacy#cookies">p</a>'));
      failsWith(dir, /\/privacy/);
    });
    it("a link to / , to an existing file, to a page without .html and with a fragment passes", () => {
      const dir = fixture(tmp.path, "app");
      put(dir, "404.html", page(APP, '<a href="/">a</a><a href="/command-line#x">b</a><a href="/cli/onetime.mjs">c</a><a href="#top">d</a><a href="' + INFO + '/privacy">e</a>'));
      expect(check(dir).code).toBe(0);
    });
  });

  describe("5: _redirects", () => {
    it("app: a / or /index.html source fails", () => {
      for (const source of ["/", "/index.html"]) {
        const dir = fixture(tmp.path, "app");
        put(dir, "_redirects", `${redirectsForApp()}${source} ${INFO}/ 301\n`);
        failsWith(dir, /_redirects.*(\/|index)/);
        rmSync(dir, { recursive: true });
      }
    });
    it("app and info: a missing, changed or extra-rule _redirects fails", () => {
      for (const profile of ["app", "info"] as const) {
        const text = profile === "app" ? redirectsForApp() : redirectsForInfo();
        for (const change of [null, text.replace(" 301", " 302"), `${text}/extra ${APP}/ 301\n`, text.split("\n").slice(1).join("\n")]) {
          const dir = fixture(tmp.path, profile);
          if (change === null) rmSync(join(dir, "_redirects"));
          else put(dir, "_redirects", change);
          failsWith(dir, /_redirects/);
          rmSync(dir, { recursive: true });
        }
      }
    });
  });

  describe("6: origins of resources", () => {
    it("app: a resource URL to the info origin fails; a link to it passes", () => {
      const dir = fixture(tmp.path, "app");
      put(dir, "404.html", page(APP, `<img src="${INFO}/x.png">`));
      failsWith(dir, /external URL/);
      put(dir, "404.html", page(APP, `<a href="${INFO}/privacy">p</a>`));
      expect(check(dir).code).toBe(0);
    });
    it("info: a resource URL to the app origin fails; a link to it passes", () => {
      const dir = fixture(tmp.path, "info");
      put(dir, "404.html", page(INFO, `<script src="${APP}/x.js"></script>`));
      failsWith(dir, /external URL/);
      put(dir, "404.html", page(INFO, `<a href="${APP}/command-line">c</a>`));
      expect(check(dir).code).toBe(0);
    });
    it("selfhost: onetimepass-info anywhere fails", () => {
      const dir = fixture(tmp.path, "selfhost");
      put(dir, "robots.txt", `Sitemap: ${INFO}/sitemap.xml\n`);
      failsWith(dir, /onetimepass-info/);
    });
  });
});
