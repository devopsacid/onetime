import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSite, SiteError, type Site, type StaticResult } from "../../server/static";
import { makeDist, tempDir } from "./helpers";

const hdr = (r: StaticResult, name: string) => r.headers.find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1];
const text = (r: StaticResult) => (r.body === null ? "" : new TextDecoder().decode(r.body));
const GOOGLE = "https://www.googletagmanager.com";

describe("static site", () => {
  const tmp = tempDir();
  let site: Site;
  beforeAll(() => {
    site = loadSite(makeDist(tmp.path));
  });
  afterAll(() => tmp.remove());
  const get = (target: string) => site.resolve(target, "GET");

  it("serves / and the clean URLs with 200 and the page body", () => {
    expect(get("/").status).toBe(200);
    expect(text(get("/"))).toContain("<title>index</title>");
    expect(hdr(get("/"), "Content-Type")).toBe("text/html; charset=utf-8");
    expect(hdr(get("/"), "Cache-Control")).toBe("no-store");
    expect(hdr(get("/"), "Content-Security-Policy")).not.toContain(GOOGLE);
    for (const path of ["/how-it-works", "/command-line", "/privacy", "/404"]) {
      expect(get(path).status).toBe(200);
      expect(text(get(path))).toContain(`<title>${path.slice(1)}</title>`);
    }
    expect(hdr(get("/how-it-works"), "Content-Security-Policy")).toContain(GOOGLE);
    expect(hdr(get("/how-it-works"), "Cache-Control")).toBe("no-store");
  });

  it("redirects /index.html, /index and *.html with 308 to the clean URL", () => {
    for (const [from, to] of [
      ["/index.html", "/"],
      ["/index", "/"],
      ["/how-it-works.html", "/how-it-works"],
      ["/how-it-works%2ehtml", "/how-it-works"],
      ["/how-it-works%2Ehtml", "/how-it-works"],
      ["/404.html", "/404"],
    ] as const) {
      const r = get(from);
      expect([from, r.status, hdr(r, "Location")]).toEqual([from, 308, to]);
      expect(r.body === null || r.body.length === 0).toBe(true);
    }
    // The redirect carries the request-path rules.
    expect(hdr(get("/index.html"), "Cache-Control")).toBe("no-store");
  });

  it("keeps the query string in a redirect and ignores it for a page", () => {
    expect(hdr(get("/how-it-works.html?a=1"), "Location")).toBe("/how-it-works?a=1");
    expect(get("/?utm=1").status).toBe(200);
  });

  it("redirects a trailing slash to the page, with only the /* rules", () => {
    const r = get("/how-it-works/");
    expect(r.status).toBe(308);
    expect(hdr(r, "Location")).toBe("/how-it-works");
    expect(hdr(r, "Content-Security-Policy")).not.toContain(GOOGLE);
    expect(hdr(r, "Cache-Control")).toBeUndefined();
  });

  it.each(["/nope", "/nope.html", "/assets/", "/assets/nope.js", "/cli", "/cli/", "/_headers", "/_routes.json", "/_selfhost.json", "/HOW-IT-WORKS", "//how-it-works", "/.env", "/assets"])(
    "answers 404 with the 404 page for %s",
    (path) => {
      const r = get(path);
      expect(r.status).toBe(404);
      expect(text(r)).toContain("<title>404</title>");
      expect(hdr(r, "Cache-Control")).toBe("no-store");
      expect(hdr(r, "Content-Security-Policy")).toBeDefined();
    },
  );

  it("forces no-store on a missing asset and keeps noindex under /cli/", () => {
    expect(hdr(get("/assets/nope.js"), "Cache-Control")).toBe("no-store");
    expect(hdr(get("/cli/"), "X-Robots-Tag")).toBe("noindex");
  });

  it.each([
    "/../etc/passwd",
    "/%2e%2e/etc/passwd",
    "/%2E%2E/etc/passwd",
    "/a/../b",
    "/a/./b",
    "/./",
    "/%00",
    "/a%00b",
    "/a\\b",
    "/a%5Cb",
    "/%zz",
    "/%",
    "/assets/..%2f..%2fetc/passwd",
    "no-slash",
    "",
    "*",
  ])("answers 400 for %j", (path) => {
    const r = get(path);
    expect(r.status).toBe(400);
    expect(hdr(r, "Content-Security-Policy")).toBeUndefined();
  });

  it("serves files without a Cache-Control rule with the Pages default and an ETag", () => {
    for (const path of ["/robots.txt", "/favicon.svg", "/cli/onetime.mjs", "/manifest.webmanifest", "/sitemap.xml"]) {
      const r = get(path);
      expect(r.status).toBe(200);
      expect(hdr(r, "Cache-Control")).toBe("public, max-age=0, must-revalidate");
      expect(hdr(r, "ETag")).toMatch(/^"[A-Za-z0-9_-]{16,}"$/);
    }
    expect(hdr(get("/cli/onetime.mjs"), "X-Robots-Tag")).toBe("noindex");
  });

  it("serves assets as immutable", () => {
    const r = get("/assets/main-abc123.js");
    expect(hdr(r, "Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(hdr(r, "Content-Type")).toBe("application/javascript");
  });

  it("uses the documented content types", () => {
    const types: Record<string, string> = {
      "/robots.txt": "text/plain; charset=utf-8",
      "/manifest.webmanifest": "application/manifest+json",
      "/favicon.svg": "image/svg+xml",
      "/icon.png": "image/png",
      "/sitemap.xml": "application/xml",
      "/cli/onetime.mjs": "application/javascript",
      "/cli/onetime.cmd": "application/octet-stream",
      "/cli/onetime.mjs.sha256": "application/octet-stream",
      "/assets/style-abc123.css": "text/css; charset=utf-8",
    };
    for (const [path, type] of Object.entries(types)) expect([path, hdr(get(path), "Content-Type")]).toEqual([path, type]);
  });

  it("sets Content-Length, and the same ETag for the same bytes", () => {
    const r = get("/robots.txt");
    expect(hdr(r, "Content-Length")).toBe(String(r.body!.length));
    expect(hdr(get("/robots.txt"), "ETag")).toBe(hdr(r, "ETag"));
    expect(hdr(get("/favicon.svg"), "ETag")).not.toBe(hdr(r, "ETag"));
  });

  it("answers 304 without a body to a matching If-None-Match, with the same headers", () => {
    const full = get("/robots.txt");
    const etag = hdr(full, "ETag")!;
    for (const header of [etag, `W/${etag}`, `"zzz", ${etag}`, "*"]) {
      const r = site.resolve("/robots.txt", "GET", header);
      expect([header, r.status]).toEqual([header, 304]);
      expect(r.body).toBeNull();
      expect(hdr(r, "ETag")).toBe(etag);
      expect(hdr(r, "Cache-Control")).toBe(hdr(full, "Cache-Control"));
    }
    expect(site.resolve("/robots.txt", "GET", '"other"').status).toBe(200);
  });

  it("keeps ETag, the rule headers and Cache-Control on a 304 (live omits ETag and the default Cache-Control; RFC 9110 asks for them)", () => {
    for (const path of ["/how-it-works", "/robots.txt", "/assets/main-abc123.js"]) {
      const full = get(path);
      const r = site.resolve(path, "GET", hdr(full, "ETag"));
      expect([path, r.status]).toEqual([path, 304]);
      expect(r.headers.map(([n]) => n.toLowerCase()).filter((n) => n !== "content-type" && n !== "content-length")).toEqual(
        full.headers.map(([n]) => n.toLowerCase()).filter((n) => n !== "content-type" && n !== "content-length"),
      );
      expect(hdr(r, "Cache-Control")).toBe(hdr(full, "Cache-Control"));
      expect(hdr(r, "ETag")).toBe(hdr(full, "ETag"));
    }
  });

  it("sends a 400 with only Content-Type, Cache-Control and no site rule headers", () => {
    const r = get("/%2e%2e/etc/passwd");
    expect(r.status).toBe(400);
    expect(r.headers.map(([n]) => n.toLowerCase()).sort()).toEqual(["cache-control", "content-type"]);
    expect(hdr(r, "Cache-Control")).toBe("no-store");
  });

  it("answers HEAD with the GET headers and no body", () => {
    const head = site.resolve("/how-it-works", "HEAD");
    const full = get("/how-it-works");
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect(hdr(head, "Content-Length")).toBe(hdr(full, "Content-Length"));
    expect(hdr(head, "Content-Security-Policy")).toBe(hdr(full, "Content-Security-Policy"));
  });

  it("answers 405 with Allow for other methods", () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const r = site.resolve("/", method);
      expect([method, r.status, hdr(r, "Allow")]).toEqual([method, 405, "GET, HEAD"]);
    }
  });

  it("reports the origin from _selfhost.json", () => {
    expect(site.origin).toBe("https://onetime.example");
  });
});

describe("loadSite refusals", () => {
  it("refuses a dist without _selfhost.json", () => {
    const tmp = tempDir();
    try {
      expect(() => loadSite(makeDist(tmp.path, { selfhost: false }))).toThrow(SiteError);
      expect(() => loadSite(makeDist(tmp.path, { selfhost: false }))).toThrow(/_selfhost\.json/);
    } finally {
      tmp.remove();
    }
  });

  it.each(["not json", "{}", '{"origin": 5}', '{"origin": ""}'])("refuses an invalid _selfhost.json %j", (content) => {
    const tmp = tempDir();
    try {
      const dist = makeDist(tmp.path);
      writeFileSync(join(dist, "_selfhost.json"), content);
      expect(() => loadSite(dist)).toThrow(SiteError);
    } finally {
      tmp.remove();
    }
  });

  it("refuses a missing directory and a missing _headers", () => {
    const tmp = tempDir();
    try {
      expect(() => loadSite(join(tmp.path, "nope"))).toThrow(SiteError);
      const dist = makeDist(tmp.path);
      rmSync(join(dist, "_headers"));
      expect(() => loadSite(dist)).toThrow(/_headers/);
    } finally {
      tmp.remove();
    }
  });

  it("refuses a symlink anywhere in dist, to a file or a directory", () => {
    const tmp = tempDir();
    try {
      const dist = makeDist(tmp.path);
      writeFileSync(join(tmp.path, "secret.txt"), "x");
      symlinkSync(join(tmp.path, "secret.txt"), join(dist, "assets", "link.txt"));
      expect(() => loadSite(dist)).toThrow(/symlink/i);
      rmSync(join(dist, "assets", "link.txt"));
      mkdirSync(join(tmp.path, "outside"));
      symlinkSync(join(tmp.path, "outside"), join(dist, "linked-dir"));
      expect(() => loadSite(dist)).toThrow(/symlink/i);
    } finally {
      tmp.remove();
    }
  });

  it("refuses an unsupported _headers file", () => {
    const tmp = tempDir();
    try {
      const dist = makeDist(tmp.path);
      writeFileSync(join(dist, "_headers"), "/blog/:slug\n  X: 1\n");
      expect(() => loadSite(dist)).toThrow(SiteError);
    } finally {
      tmp.remove();
    }
  });
});

describe("route inputs", () => {
  it("pins _routes.json to the API only, so the Node server and Pages cannot drift", async () => {
    const { readFileSync } = await import("node:fs");
    const routes = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "public", "_routes.json"), "utf8")) as { include: string[] };
    expect(routes.include).toEqual(["/api/*"]);
  });
});
