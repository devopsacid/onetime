import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../server/http";
import { loadSite } from "../../server/static";
import { openSqliteStore, type SqliteStore } from "../../server/store-sqlite";
import { ID_PATTERN } from "../../src/shared/limits";
import { ROOT, makeDist, migrations, tempDir } from "./helpers";

const SCRIPT = join(ROOT, "tools", "burn-id.mjs");
const KEY = "k".repeat(43);

interface Run {
  code: number | null;
  out: string;
  err: string;
}

const run = (args: string[]): Promise<Run> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  });

describe("tools/burn-id.mjs", () => {
  let dir: ReturnType<typeof tempDir>;
  let store: SqliteStore;
  let app: ReturnType<typeof createApp>;
  let origin: string;
  let seen: Array<{ method: string; url: string }>;

  beforeEach(async () => {
    dir = tempDir();
    store = openSqliteStore(join(dir.path, "b.db"), migrations());
    app = createApp({ store, site: loadSite(makeDist(dir.path)), maxStored: 100 });
    seen = [];
    app.server.on("request", (req) => seen.push({ method: req.method ?? "", url: req.url ?? "" }));
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await app.drain();
    await store.close();
    dir.remove();
  });

  async function create(): Promise<string> {
    const response = await fetch(`${origin}/api/secrets?ttl=3600`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: crypto.getRandomValues(new Uint8Array(100)),
    });
    return ((await response.json()) as { id: string }).id;
  }
  const rows = () => (store.db.prepare("SELECT COUNT(*) AS n FROM secrets").get() as { n: number }).n;
  const revealCalls = () => seen.filter((r) => r.url.includes("/reveal"));

  it("has the same id pattern as the app", async () => {
    const source = (await import("node:fs")).readFileSync(SCRIPT, "utf8");
    expect(source).toContain(ID_PATTERN.source);
  });

  it("deletes a stored secret given its id and prints only 'deleted'", async () => {
    const id = await create();
    expect(rows()).toBe(1);
    const r = await run([origin, id]);
    expect(r).toEqual({ code: 0, out: "deleted\n", err: "" });
    expect(rows()).toBe(0);
    expect(revealCalls()).toEqual([{ method: "POST", url: `/api/secrets/${id}/reveal` }]);
  });

  it.each([
    ["a v1 link", (id: string) => `${origin}/#${id}.${KEY}`],
    ["a 2 link", (id: string) => `${origin}/#2.${id}.${KEY}`],
    ["a 2f link", (id: string) => `${origin}/#2f.${id}.${KEY}`],
    ["a 2fp link", (id: string) => `${origin}/#2fp.${id}.${KEY}`],
    ["id.key", (id: string) => `${id}.${KEY}`],
    ["2f.id.key", (id: string) => `2f.${id}.${KEY}`],
    ["#2f.id.key", (id: string) => `#2f.${id}.${KEY}`],
    ["2f.id (key removed)", (id: string) => `2f.${id}`],
    ["2fp.id", (id: string) => `2fp.${id}`],
    ["2.id", (id: string) => `2.${id}`],
    ["2p.id", (id: string) => `2p.${id}`],
    ["a URL with #2f.id", (id: string) => `${origin}/#2f.${id}`],
    ["a URL with #2fp.id", (id: string) => `${origin}/#2fp.${id}`],
    ["a URL with #2p.id", (id: string) => `${origin}/#2p.${id}`],
    ["a URL with #2.id", (id: string) => `${origin}/#2.${id}`],
    ["2fp.id.key", (id: string) => `2fp.${id}.${KEY}`],
    ["2p.id.key", (id: string) => `2p.${id}.${KEY}`],
  ])("takes %s: only the id is sent, the key is never printed or sent", async (_label, make) => {
    const id = await create();
    const r = await run([origin, make(id)]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("deleted\n");
    expect(`${r.out}${r.err}`).not.toContain(KEY);
    expect(JSON.stringify(seen)).not.toContain(KEY);
    expect(revealCalls()).toEqual([{ method: "POST", url: `/api/secrets/${id}/reveal` }]);
    expect(rows()).toBe(0);
  });

  describe("the link example on the privacy page", () => {
    const privacy = readFileSync(join(ROOT, "privacy.html"), "utf8");
    const exampleId = /<span class="u-id">([^<]+)<\/span>/.exec(privacy)?.[1] ?? "";
    const exampleKey = /<span class="u-key">([^<]+)<\/span>/.exec(privacy)?.[1] ?? "";
    it("has a well-formed made-up id and key", () => {
      expect(exampleId).toMatch(ID_PATTERN);
      expect(exampleKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });
    it("names every link form below the example", () => {
      for (const form of ["#&lt;id&gt;.&lt;key&gt;", "#2.&lt;id&gt;", "#2p.&lt;id&gt;", "#2f.&lt;id&gt;", "#2fp.&lt;id&gt;"]) expect(privacy).toContain(form);
    });
    it.each(["", "2.", "2p.", "2f.", "2fp."])("link form #%s<id>.<key>: burn-id sends the example id, never the key", async (prefix) => {
      const r = await run([origin, `https://onetimepass.pages.dev/#${prefix}${exampleId}.${exampleKey}`]);
      expect(r).toEqual({ code: 0, out: "not stored\n", err: "" });
      expect(JSON.stringify(seen)).not.toContain(exampleKey);
      expect(revealCalls()).toEqual([{ method: "POST", url: `/api/secrets/${exampleId}/reveal` }]);
    });
  });

  it("uses the origin argument, not the one inside a link", async () => {
    const id = await create();
    const r = await run([origin, `https://elsewhere.example/#2f.${id}.${KEY}`]);
    expect(r.out).toBe("deleted\n");
    expect(rows()).toBe(0);
  });

  it("prints 'not stored' with exit 0 when the secret is gone, or never existed", async () => {
    const id = await create();
    await run([origin, id]);
    expect(await run([origin, id])).toEqual({ code: 0, out: "not stored\n", err: "" });
    expect(await run([origin, "A".repeat(22)])).toEqual({ code: 0, out: "not stored\n", err: "" });
  });

  it("does not echo the key when the input is damaged, and sends nothing", async () => {
    const bad = [
      "short",
      "A".repeat(23),
      "A".repeat(21),
      `../../etc/passwd.${KEY}`,
      `${"A".repeat(22)}/../x`,
      `${origin}/#2f.${"A".repeat(21)}.${KEY}`,
      `2f.${KEY}`,
      `a.b.c.d.${KEY}`,
      "",
    ];
    for (const input of bad) {
      const r = await run([origin, input]);
      expect(r.code, input).toBe(2);
      expect(r.out).toBe("");
      expect(`${r.out}${r.err}`).not.toContain(KEY);
      expect(r.err).not.toContain("passwd");
    }
    expect(seen).toEqual([]);
  });

  it("refuses a bad origin and missing arguments with exit 2 and sends nothing", async () => {
    const id = "A".repeat(22);
    for (const args of [[], [origin], ["http://evil.example", id], ["ftp://x.example", id], ["not a url", id], [origin, id, "extra"]]) {
      const r = await run(args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.out).toBe("");
    }
    expect(seen).toEqual([]);
  });

  it("exits 5 when the server cannot be reached or answers an error", async () => {
    const down = await run(["http://127.0.0.1:1", "A".repeat(22)]);
    expect(down.code).toBe(5);
    expect(down.out).toBe("");
    const broken = await run([origin, "A".repeat(22)]); // fine
    expect(broken.code).toBe(0);
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    expect((await run([origin, "A".repeat(22)])).code).toBe(5);
  });
});
