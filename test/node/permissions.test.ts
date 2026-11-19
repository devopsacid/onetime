import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { permissionWarning } from "../../server/permissions";
import { buildServerBundle, makeDist, runServer, tempDir, waitFor } from "./helpers";

function layout(dirMode: number, dbMode: number, walMode?: number) {
  const dir = tempDir();
  const data = join(dir.path, "data");
  mkdirSync(data);
  chmodSync(data, dirMode);
  const db = join(data, "onetime.db");
  writeFileSync(db, "x");
  chmodSync(db, dbMode);
  if (walMode !== undefined) {
    writeFileSync(`${db}-wal`, "x");
    chmodSync(`${db}-wal`, walMode);
  }
  return { db, data };
}

describe("permissionWarning", () => {
  it("is silent for a private folder and private files, and when nothing exists yet", () => {
    expect(permissionWarning(layout(0o700, 0o600, 0o600).db)).toBeNull();
    expect(permissionWarning(join(tempDir().path, "nope", "x.db"))).toBeNull();
  });

  it.each([
    ["a group-readable folder", 0o750, 0o600, undefined, /folder .*mode 750/],
    ["a world-accessible folder", 0o755, 0o600, undefined, /folder .*mode 755/],
    ["a group-readable database", 0o700, 0o640, undefined, /onetime\.db has mode 640/],
    ["a world-readable database", 0o700, 0o644, undefined, /onetime\.db has mode 644/],
    ["a world-readable WAL file", 0o700, 0o600, 0o644, /onetime\.db-wal has mode 644/],
  ])("warns in one line for %s", (_name, dirMode, dbMode, walMode, pattern) => {
    const warning = permissionWarning(layout(dirMode, dbMode, walMode).db);
    expect(warning).toMatch(pattern);
    expect(warning).not.toContain("\n");
    expect(warning).toMatch(/^onetime: warning: /);
  });

  it("says nothing on Windows, where modes mean nothing", () => {
    expect(permissionWarning(layout(0o777, 0o666).db, "win32")).toBeNull();
  });
});

describe("the built server and permissions", () => {
  const tmp = tempDir();
  let bundle: string;
  beforeAll(async () => {
    bundle = join(tmp.path, "dist-server", "server.mjs");
    await buildServerBundle(bundle);
    mkdirSync(join(tmp.path, "migrations"), { recursive: true });
    writeFileSync(join(tmp.path, "migrations", "0001_init.sql"), "CREATE TABLE secrets (id TEXT PRIMARY KEY, blob BLOB NOT NULL, expires_at INTEGER NOT NULL);");
    makeDist(tmp.path);
  });
  const env = (db: string) => ({ HOST: "127.0.0.1", PORT: "0", ONETIME_DB: db, ONETIME_DIST: join(tmp.path, "dist-selfhost") });

  it("starts, prints one warning line to stderr for a world-readable data folder, and keeps going", async () => {
    const data = join(tmp.path, "open");
    mkdirSync(data);
    chmodSync(data, 0o755);
    const child = runServer(bundle, env(join(data, "o.db")));
    await waitFor(() => /listening on/.test(child.stdout()) || child.process.exitCode !== null);
    expect(child.stdout()).toMatch(/listening on/);
    expect(child.stderr().trim().split("\n")).toHaveLength(1);
    expect(child.stderr()).toMatch(/^onetime: warning: folder .*mode 755/);
    child.process.kill("SIGTERM");
    expect(await child.exited).toBe(0);
  });

  it("prints nothing to stderr when the server creates its own folder", async () => {
    const child = runServer(bundle, env(join(tmp.path, "fresh", "o.db")));
    await waitFor(() => /listening on/.test(child.stdout()) || child.process.exitCode !== null);
    expect(child.stderr()).toBe("");
    child.process.kill("SIGTERM");
    expect(await child.exited).toBe(0);
  });
});
