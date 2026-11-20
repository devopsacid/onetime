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
      maxConnections: 1000,
      maxStoredBytes: 400_000_000,
      maxLargeBytes: 200_000_000,
      maxFileBytes: 262_144,
      maxFileTtl: 3600,
      maxUploads: 16,
    });
  });

  it("defaults the file lifetime to 1 hour and lets ONETIME_MAX_FILE_TTL raise it", () => {
    expect(parseConfig({}, BASE, "/w").maxFileTtl).toBe(3600);
    expect(parseConfig({ ONETIME_MAX_FILE_TTL: "86400" }, BASE, "/w").maxFileTtl).toBe(86_400);
  });

  it("reads ONETIME_MAX_FILE_BYTES up to the 5 MiB ceiling and ONETIME_MAX_FILE_TTL", () => {
    expect(parseConfig({ ONETIME_MAX_FILE_BYTES: "1048576" }, BASE, "/w").maxFileBytes).toBe(1_048_576);
    expect(parseConfig({ ONETIME_MAX_FILE_BYTES: "5242880" }, BASE, "/w").maxFileBytes).toBe(5_242_880);
    expect(parseConfig({ ONETIME_MAX_FILE_BYTES: "1" }, BASE, "/w").maxFileBytes).toBe(1);
    expect(parseConfig({ ONETIME_MAX_FILE_TTL: "3600" }, BASE, "/w").maxFileTtl).toBe(3600);
    expect(parseConfig({ ONETIME_MAX_FILE_TTL: "604800" }, BASE, "/w").maxFileTtl).toBe(604_800);
  });

  it.each([
    ["ONETIME_MAX_FILE_BYTES", "5242881"],
    ["ONETIME_MAX_FILE_BYTES", "-1"],
    ["ONETIME_MAX_FILE_BYTES", "5 MiB"],
    ["ONETIME_MAX_FILE_BYTES", "1.5"],
    ["ONETIME_MAX_FILE_TTL", "59"],
    ["ONETIME_MAX_FILE_TTL", "604801"],
    ["ONETIME_MAX_FILE_TTL", "1h"],
  ])("rejects %s=%j", (name, value) => {
    expect(() => parseConfig({ [name]: value }, BASE, "/w")).toThrow(ConfigError);
    expect(() => parseConfig({ [name]: value }, BASE, "/w")).toThrow(new RegExp(name));
  });

  it("turns files off with ONETIME_MAX_FILE_BYTES=0 and also zeroes the large budget", () => {
    expect(parseConfig({ ONETIME_MAX_FILE_BYTES: "0" }, BASE, "/w")).toMatchObject({ maxFileBytes: 0, maxLargeBytes: 0 });
  });

  it("turns files off with ONETIME_MAX_LARGE_BYTES=0 and also zeroes the file size, so the two settings never disagree", () => {
    expect(parseConfig({ ONETIME_MAX_LARGE_BYTES: "0" }, BASE, "/w")).toMatchObject({ maxFileBytes: 0, maxLargeBytes: 0 });
    expect(parseConfig({ ONETIME_MAX_LARGE_BYTES: "0", ONETIME_MAX_FILE_BYTES: "1048576" }, BASE, "/w")).toMatchObject({ maxFileBytes: 0, maxLargeBytes: 0 });
  });

  it("rejects a large budget too small for one file of the configured size (every upload would answer 503)", () => {
    const env = { ONETIME_MAX_FILE_BYTES: "5242880", ONETIME_MAX_LARGE_BYTES: "5000000" };
    expect(() => parseConfig(env, BASE, "/w")).toThrow(/ONETIME_MAX_LARGE_BYTES/);
    expect(parseConfig({ ONETIME_MAX_FILE_BYTES: "5242880", ONETIME_MAX_LARGE_BYTES: "5243298" }, BASE, "/w").maxLargeBytes).toBe(5_243_298);
  });

  it("reads the three file settings", () => {
    const c = parseConfig({ ONETIME_MAX_STORED_BYTES: "50000000", ONETIME_MAX_LARGE_BYTES: "10000000", ONETIME_MAX_UPLOADS: "4" }, BASE, "/w");
    expect(c).toMatchObject({ maxStoredBytes: 50_000_000, maxLargeBytes: 10_000_000, maxUploads: 4 });
  });

  it("accepts the bounds of the file settings, including ONETIME_MAX_LARGE_BYTES=0 (files off)", () => {
    expect(parseConfig({ ONETIME_MAX_STORED_BYTES: "1000000", ONETIME_MAX_LARGE_BYTES: "0" }, BASE, "/w")).toMatchObject({ maxStoredBytes: 1_000_000, maxLargeBytes: 0, maxFileBytes: 0 });
    expect(parseConfig({ ONETIME_MAX_STORED_BYTES: "1000000000000" }, BASE, "/w").maxStoredBytes).toBe(1_000_000_000_000);
    expect(parseConfig({ ONETIME_MAX_STORED_BYTES: "5000000", ONETIME_MAX_LARGE_BYTES: "5000000" }, BASE, "/w").maxLargeBytes).toBe(5_000_000);
    expect(parseConfig({ ONETIME_MAX_STORED_BYTES: "1000000" }, BASE, "/w")).toMatchObject({ maxLargeBytes: 1_000_000, maxFileBytes: 262_144 });
    expect(parseConfig({ ONETIME_MAX_UPLOADS: "1" }, BASE, "/w").maxUploads).toBe(1);
    expect(parseConfig({ ONETIME_MAX_UPLOADS: "1000" }, BASE, "/w").maxUploads).toBe(1000);
  });

  it("lowers the default large budget to the stored-bytes value when only that is set", () => {
    expect(parseConfig({ ONETIME_MAX_STORED_BYTES: "100000000" }, BASE, "/w")).toMatchObject({ maxStoredBytes: 100_000_000, maxLargeBytes: 100_000_000 });
  });

  it.each([
    ["ONETIME_MAX_STORED_BYTES", "999999"],
    ["ONETIME_MAX_STORED_BYTES", "1000000000001"],
    ["ONETIME_MAX_STORED_BYTES", "abc"],
    ["ONETIME_MAX_STORED_BYTES", "1e9"],
    ["ONETIME_MAX_LARGE_BYTES", "-1"],
    ["ONETIME_MAX_LARGE_BYTES", "1.5"],
    ["ONETIME_MAX_UPLOADS", "0"],
    ["ONETIME_MAX_UPLOADS", "1001"],
    ["ONETIME_MAX_UPLOADS", "many"],
  ])("rejects %s=%j", (name, value) => {
    expect(() => parseConfig({ [name]: value }, BASE, "/w")).toThrow(ConfigError);
    expect(() => parseConfig({ [name]: value }, BASE, "/w")).toThrow(new RegExp(name));
  });

  it("rejects a large budget above the stored-bytes value", () => {
    const env = { ONETIME_MAX_STORED_BYTES: "5000000", ONETIME_MAX_LARGE_BYTES: "5000001" };
    expect(() => parseConfig(env, BASE, "/w")).toThrow(/ONETIME_MAX_LARGE_BYTES/);
    expect(() => parseConfig({ ONETIME_MAX_LARGE_BYTES: "400000001" }, BASE, "/w")).toThrow(/ONETIME_MAX_LARGE_BYTES/);
  });

  it("reads every variable and resolves relative paths against the working directory", () => {
    const c = parseConfig({ HOST: "0.0.0.0", PORT: "9090", ONETIME_DB: "x/y.db", ONETIME_DIST: "site", ONETIME_MAX_STORED: "5", ONETIME_MAX_CONNECTIONS: "50" }, BASE, "/work");
    expect(c).toMatchObject({ host: "0.0.0.0", port: 9090, dbPath: "/work/x/y.db", distDir: "/work/site", maxStored: 5, maxConnections: 50 });
    expect(parseConfig({ ONETIME_DB: "/data/o.db" }, BASE, "/work").dbPath).toBe("/data/o.db");
  });

  it("treats empty values as unset", () => {
    expect(parseConfig({ HOST: "", PORT: "", ONETIME_MAX_STORED: "" }, BASE, "/w")).toMatchObject({ host: "127.0.0.1", port: 8080, maxStored: 20_000 });
  });

  it("accepts the limits of ONETIME_MAX_CONNECTIONS", () => {
    expect(parseConfig({ ONETIME_MAX_CONNECTIONS: "1" }, BASE, "/w").maxConnections).toBe(1);
    expect(parseConfig({ ONETIME_MAX_CONNECTIONS: "100000" }, BASE, "/w").maxConnections).toBe(100_000);
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
    ["ONETIME_MAX_CONNECTIONS", "0"],
    ["ONETIME_MAX_CONNECTIONS", "100001"],
    ["ONETIME_MAX_CONNECTIONS", "1e3"],
    ["ONETIME_MAX_CONNECTIONS", "-1"],
    ["ONETIME_MAX_CONNECTIONS", "lots"],
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
