import { afterEach, describe, expect, it, vi } from "vitest";
import { USAGE_KINDS, kindFor } from "../src/shared/usage";
import { LIMITS_VIEW_URL, createSecret, fetchLimits, revealSecret } from "../src/web/api";
import { whenActivated } from "../src/web/activation";
import { parseFragment } from "../src/web/link";
import main from "../src/web/main.ts?raw";

afterEach(() => vi.unstubAllGlobals());

const ID = "a".repeat(22);
const KEY = "b".repeat(43);

function recordFetch(response: () => Response): string[] {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => (urls.push(url), response()));
  return urls;
}

describe("kind of a link", () => {
  it("kindFor covers all four combinations", () => {
    expect(kindFor({ file: false, passphrase: false })).toBe("text");
    expect(kindFor({ file: false, passphrase: true })).toBe("text-pass");
    expect(kindFor({ file: true, passphrase: false })).toBe("file");
    expect(kindFor({ file: true, passphrase: true })).toBe("file-pass");
    expect(USAGE_KINDS).toHaveLength(4);
  });

  it("a v1 link is a text without a passphrase", () => {
    const link = parseFragment(`#${ID}.${KEY}`);
    expect(link).not.toBe("invalid");
    expect(link && link !== "invalid" ? kindFor(link) : null).toBe("text");
  });

  it("v2 links give their own kinds", () => {
    for (const [prefix, kind] of [["2", "text"], ["2p", "text-pass"], ["2f", "file"], ["2fp", "file-pass"]] as const) {
      const link = parseFragment(`#${prefix}.${ID}.${KEY}`);
      expect(link && link !== "invalid" ? kindFor(link) : null).toBe(kind);
    }
  });
});

describe("kind on the wire", () => {
  it("createSecret requests exactly /api/secrets?ttl=<n>&kind=<k>", async () => {
    const urls = recordFetch(() => new Response(JSON.stringify({ id: "x" }), { status: 201 }));
    await createSecret(new Uint8Array(40), 3600, "file-pass");
    expect(urls).toEqual(["/api/secrets?ttl=3600&kind=file-pass"]);
  });

  it("revealSecret requests /api/secrets/<id>/reveal?kind=<k>", async () => {
    const urls = recordFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    await revealSecret(ID, { kind: "text-pass" });
    expect(urls).toEqual([`/api/secrets/${ID}/reveal?kind=text-pass`]);
  });

  it("no URL contains a fragment or a key", async () => {
    const urls = recordFetch(() => new Response(new Uint8Array([1]), { status: 200 }));
    await revealSecret(ID, { kind: "text" });
    for (const url of urls) {
      expect(url).not.toContain("#");
      expect(url).not.toContain(KEY);
    }
  });
});

describe("fetchLimits beacon", () => {
  const body = () => new Response(JSON.stringify({ maxFileBytes: 262_144, maxFileTtl: 3600, maxTextBytes: 16_384 }), { status: 200 });

  it("requests exactly /api/limits without the beacon", async () => {
    const urls = recordFetch(body);
    await fetchLimits();
    expect(urls).toEqual(["/api/limits"]);
  });

  it("requests exactly /api/limits?view=app with the beacon URL, a fixed string", async () => {
    const urls = recordFetch(body);
    expect(LIMITS_VIEW_URL).toBe("/api/limits?view=app");
    await fetchLimits({ url: LIMITS_VIEW_URL });
    expect(urls).toEqual(["/api/limits?view=app"]);
  });

  it("main.ts sends the beacon only when __SITE__ is app, after whenActivated, and never builds a URL from location", () => {
    expect(main).toMatch(/__SITE__\s*===\s*"app"[^;]*LIMITS_VIEW_URL/s);
    expect(main).toContain("whenActivated(");
    expect(main).not.toMatch(/view=app/);
    expect(main).not.toMatch(/fetchLimits\([^)]*location/);
  });
});

describe("whenActivated", () => {
  it("resolves at once when the document is not prerendering", async () => {
    const doc = { prerendering: false, addEventListener: vi.fn() };
    await whenActivated(doc);
    expect(doc.addEventListener).not.toHaveBeenCalled();
  });

  it("resolves at once when the browser has no prerendering support", async () => {
    await whenActivated({ addEventListener: vi.fn() });
  });

  it("waits for prerenderingchange when prerendering", async () => {
    let fire: () => void = () => {};
    const doc = {
      prerendering: true,
      addEventListener: (type: string, listener: () => void) => {
        expect(type).toBe("prerenderingchange");
        fire = listener;
      },
    };
    let done = false;
    const promise = whenActivated(doc).then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    fire();
    await promise;
    expect(done).toBe(true);
  });
});
