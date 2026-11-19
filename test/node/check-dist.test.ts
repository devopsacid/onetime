import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { headersForSelfhost } from "../../tools/site-profile-core.mjs";
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
  }
  return dir;
}

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
});
