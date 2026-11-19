import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../../server/config";
import { buildServerBundle, makeDist, runServer, tempDir } from "./helpers";

const BASE = "/opt/onetime/dist-server";

describe("parseConfig", () => {
  it("uses the defaults", () => {
    expect(parseConfig({}, BASE, "/work")).toEqual({
      host: "127.0.0.1",
      port: 8080,
      dbPath: "/work/data/onetime.db",
      distDir: "/opt/onetime/dist-selfhost",
      migrationsDir: "/opt/onetime/migrations",
      maxStored: 20_000,
    });
  });

  it("reads every variable and resolves relative paths against the working directory", () => {
    const c = parseConfig({ HOST: "0.0.0.0", PORT: "9090", ONETIME_DB: "x/y.db", ONETIME_DIST: "site", ONETIME_MAX_STORED: "5" }, BASE, "/work");
    expect(c).toMatchObject({ host: "0.0.0.0", port: 9090, dbPath: "/work/x/y.db", distDir: "/work/site", maxStored: 5 });
    expect(parseConfig({ ONETIME_DB: "/data/o.db" }, BASE, "/work").dbPath).toBe("/data/o.db");
  });

  it("treats empty values as unset", () => {
    expect(parseConfig({ HOST: "", PORT: "", ONETIME_MAX_STORED: "" }, BASE, "/w")).toMatchObject({ host: "127.0.0.1", port: 8080, maxStored: 20_000 });
  });

  it("accepts port 0 (any free port), IPv6 and names as host", () => {
    expect(parseConfig({ PORT: "0" }, BASE, "/w").port).toBe(0);
    expect(parseConfig({ HOST: "::" }, BASE, "/w").host).toBe("::");
    expect(parseConfig({ HOST: "localhost" }, BASE, "/w").host).toBe("localhost");
  });

  it.each([
    ["PORT", "abc"],
    ["PORT", "-1"],
    ["PORT", "65536"],
    ["PORT", "80.5"],
    ["PORT", " 80"],
    ["PORT", "0x50"],
    ["ONETIME_MAX_STORED", "0"],
    ["ONETIME_MAX_STORED", "10000001"],
    ["ONETIME_MAX_STORED", "1e3"],
    ["ONETIME_MAX_STORED", "-5"],
    ["ONETIME_MAX_STORED", "many"],
    ["HOST", "bad host"],
    ["HOST", "a/b"],
    ["ONETIME_DB", "a\0b"],
  ])("rejects %s=%j", (name, value) => {
    expect(() => parseConfig({ [name]: value }, BASE, "/w")).toThrow(ConfigError);
    expect(() => parseConfig({ [name]: value }, BASE, "/w")).toThrow(new RegExp(name));
  });

  it("accepts the bounds of the cap", () => {
    expect(parseConfig({ ONETIME_MAX_STORED: "1" }, BASE, "/w").maxStored).toBe(1);
    expect(parseConfig({ ONETIME_MAX_STORED: "10000000" }, BASE, "/w").maxStored).toBe(10_000_000);
  });

  it("lists every problem at once", () => {
    try {
      parseConfig({ PORT: "x", ONETIME_MAX_STORED: "0" }, BASE, "/w");
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toMatch(/PORT/);
      expect((e as Error).message).toMatch(/ONETIME_MAX_STORED/);
    }
  });
});

describe("startup refusals of the built server", () => {
  const tmp = tempDir();
  let bundle: string;
  beforeAll(async () => {
    bundle = join(tmp.path, "dist-server", "server.mjs");
    await buildServerBundle(bundle);
    mkdirSync(join(tmp.path, "migrations"));
    writeFileSync(join(tmp.path, "migrations", "0001_init.sql"), "CREATE TABLE secrets (id TEXT PRIMARY KEY, blob BLOB NOT NULL, expires_at INTEGER NOT NULL);");
  });
  afterAll(() => tmp.remove());

  const env = (extra: Record<string, string> = {}) => ({
    PORT: "0",
    ONETIME_DB: join(tmp.path, "data", "t.db"),
    ONETIME_DIST: join(tmp.path, "dist-selfhost"),
    ...extra,
  });

  it("exits 2 for an invalid PORT and names the variable on stderr", async () => {
    const child = runServer(bundle, env({ PORT: "99999" }));
    expect(await child.exited).toBe(2);
    expect(child.stderr()).toMatch(/PORT/);
    expect(child.stdout()).toBe("");
  });

  it("exits 2 for a dist without _selfhost.json", async () => {
    const dist = makeDist(tmp.path, { selfhost: false });
    const child = runServer(bundle, env({ ONETIME_DIST: dist }));
    expect(await child.exited).toBe(2);
    expect(child.stderr()).toMatch(/_selfhost\.json/);
    rmSync(dist, { recursive: true });
  });

  it("exits 2 for a missing dist", async () => {
    const child = runServer(bundle, env({ ONETIME_DIST: join(tmp.path, "nowhere") }));
    expect(await child.exited).toBe(2);
  });
});
