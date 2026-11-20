import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { headersForSelfhost, securityTxtForPages } from "../../tools/site-profile-core.mjs";
import { PUBLIC_HEADERS, ROOT, tempDir } from "./helpers";

const ORIGIN = "https://onetime.example";
const page = (extra = "") =>
  `<!doctype html>\n<html><head><script src="/theme-init.js"></script><link rel="stylesheet" href="/assets/a.css"><script type="module" src="/assets/a.js"></script></head><body><a href="${ORIGIN}/">home</a>${extra}</body></html>\n`;

/** A minimal dist for either profile; `tweak` may change it before the checker runs. */
function fixture(root: string, profile: "selfhost" | "onetimepass"): string {
  const dir = join(root, "d");
  mkdirSync(join(dir, "assets"), { recursive: true });
  for (const name of ["index", "404", "how-it-works", "command-line", "privacy"]) writeFileSync(join(dir, `${name}.html`), page());
  writeFileSync(join(dir, "theme-init.js"), "document.documentElement.dataset.theme='light'\n");
  writeFileSync(join(dir, "assets", "a.js"), "console.log('app')\n");
  writeFileSync(join(dir, "assets", "a.css"), "body{}\n");
  const headers = readFileSync(PUBLIC_HEADERS, "utf8");
  if (profile === "selfhost") {
    writeFileSync(join(dir, "_headers"), headersForSelfhost(headers));
    writeFileSync(join(dir, "_selfhost.json"), JSON.stringify({ origin: ORIGIN }));
  } else {
    writeFileSync(join(dir, "_headers"), headers);
    for (const name of ["index", "404", "how-it-works", "command-line", "privacy"]) {
      writeFileSync(join(dir, `${name}.html`), page().replaceAll(ORIGIN, "https://onetimepass.pages.dev"));
    }
    mkdirSync(join(dir, ".well-known"));
    writeFileSync(join(dir, ".well-known", "security.txt"), securityTxtForPages({ privacyHtml: '<a href="mailto:o@example.org">o</a>', now: new Date() })!);
  }
  return dir;
}

const SELF_TXT = `Contact: mailto:sec@onetime.example\nExpires: ${new Date(Date.now() + 330 * 864e5).toISOString().slice(0, 19)}Z\nCanonical: ${ORIGIN}/.well-known/security.txt\n`;
const writeTxt = (dir: string, text: string) => {
  mkdirSync(join(dir, ".well-known"), { recursive: true });
  writeFileSync(join(dir, ".well-known", "security.txt"), text);
};

function check(dir: string): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [join(ROOT, "tools", "check-dist.mjs"), dir], { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

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
  it("pages: a clean fixture passes", () => {
    const r = check(fixture(tmp.path, "onetimepass"));
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
  it.each(["selfhost", "onetimepass"] as const)("%s: a /* rule without Permissions-Policy or CORP fails", (profile) => {
    for (const name of ["Permissions-Policy", "Cross-Origin-Resource-Policy"]) {
      const dir = fixture(tmp.path, profile);
      const text = readFileSync(join(dir, "_headers"), "utf8");
      writeFileSync(join(dir, "_headers"), text.split("\n").filter((l) => !l.trim().startsWith(`${name}:`)).join("\n"));
      const r = check(dir);
      expect(r.code).toBe(1);
      expect(r.out).toContain(name);
    }
  });
  it.each(["selfhost", "onetimepass"] as const)("%s: a Permissions-Policy that allows the camera or drops clipboard-write fails", (profile) => {
    for (const [from, to] of [["camera=()", "camera=*"], ["clipboard-write=(self)", "clipboard-write=()"]]) {
      const dir = fixture(tmp.path, profile);
      writeFileSync(join(dir, "_headers"), readFileSync(join(dir, "_headers"), "utf8").replace(from!, to!));
      expect(check(dir).code).toBe(1);
    }
  });
  it("selfhost: a leftover marker fails", () => {
    const dir = fixture(tmp.path, "selfhost");
    writeFileSync(join(dir, "privacy.html"), page("<!-- site:selfhost -->"));
    const r = check(dir);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/marker/);
  });
  it("pages: a leftover marker fails", () => {
    const dir = fixture(tmp.path, "onetimepass");
    writeFileSync(join(dir, "privacy.html"), page("<!-- /site:onetimepass -->"));
    expect(check(dir).code).toBe(1);
  });
  it("selfhost: a leftover placeholder fails", () => {
    const dir = fixture(tmp.path, "selfhost");
    writeFileSync(join(dir, "privacy.html"), page("<p>{{OPERATOR_NAME}}</p>"));
    expect(check(dir).code).toBe(1);
  });
  it("selfhost: a Google CSP in _headers fails", () => {
    const dir = fixture(tmp.path, "selfhost");
    const original = readFileSync(PUBLIC_HEADERS, "utf8");
    writeFileSync(join(dir, "_headers"), original);
    const r = check(dir);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/_headers/);
  });
  it("selfhost: the owner's origin or address outside cli/ fails, inside cli/ the project URL is allowed", () => {
    const dir = fixture(tmp.path, "selfhost");
    mkdirSync(join(dir, "cli"));
    writeFileSync(join(dir, "cli", "onetime.mjs"), "// https://onetimepass.pages.dev\n");
    expect(check(dir).code).toBe(0);
    writeFileSync(join(dir, "robots.txt"), "Sitemap: https://onetimepass.pages.dev/sitemap.xml\n");
    expect(check(dir).code).toBe(1);
    writeFileSync(join(dir, "robots.txt"), `contact ${["michal", "maxian.sk"].join("@")}\n`);
    expect(check(dir).code).toBe(1);
  });
  it("selfhost: an external resource is judged against the selfhost origin", () => {
    const dir = fixture(tmp.path, "selfhost");
    writeFileSync(join(dir, "privacy.html"), page('<img src="https://onetimepass.pages.dev/x.png">'));
    expect(check(dir).code).toBe(1);
  });
  it("pages: a stray _selfhost.json fails", () => {
    const dir = fixture(tmp.path, "onetimepass");
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
      const dir = fixture(tmp.path, "onetimepass");
      rmSync(join(dir, ".well-known"), { recursive: true });
      const r = check(dir);
      expect(r.code).toBe(1);
      expect(r.out).toContain("security.txt");
    });
    it.each(["selfhost", "onetimepass"] as const)("%s: Expires missing, past, under 30 days or over a year fails", (profile) => {
      const base = (expires: string) => `Contact: mailto:sec@example.org\n${expires}Canonical: ${profile === "selfhost" ? ORIGIN : "https://onetimepass.pages.dev"}/.well-known/security.txt\n`;
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
