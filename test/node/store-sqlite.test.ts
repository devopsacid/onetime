import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readMigrations } from "../../server/migrate";
import { openSqliteStore, StoreLockedError, type SqliteStore } from "../../server/store-sqlite";
import { MIGRATIONS_DIR, migrations, tempDir } from "./helpers";

const T0 = 1_800_000_000_000;
const blobOf = (n: number) => crypto.getRandomValues(new Uint8Array(n));

describe("SqliteStore", () => {
  let dir: ReturnType<typeof tempDir>;
  let dbPath: string;
  let store: SqliteStore;
  beforeEach(() => {
    dir = tempDir();
    dbPath = join(dir.path, "onetime.db");
    store = openSqliteStore(dbPath, migrations());
  });
  afterEach(async () => {
    await store.close();
    dir.remove();
  });

  const pragma = (name: string) => Object.values(store.db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[0];

  it("sets the durability pragmas", () => {
    expect(pragma("journal_mode")).toBe("wal");
    expect(pragma("synchronous")).toBe(2);
    expect(pragma("secure_delete")).toBe(1);
    expect(pragma("locking_mode")).toBe("exclusive");
    expect(pragma("temp_store")).toBe(2);
    expect(pragma("busy_timeout")).toBe(5000);
    expect(pragma("journal_size_limit")).toBe(4194304);
  });

  it("round-trips every byte value", async () => {
    const blob = new Uint8Array(256);
    for (let i = 0; i < 256; i++) blob[i] = i;
    expect(await store.insertIfBelowCap("a".repeat(22), blob, T0 + 1000, T0, 10)).toBe(true);
    const back = await store.take("a".repeat(22), T0);
    expect(back).toEqual(blob);
    expect(back!.buffer).toBeInstanceOf(ArrayBuffer);
    expect(await store.take("a".repeat(22), T0)).toBeNull();
  });

  it("honours the cap and expiry in the store itself", async () => {
    expect(await store.insertIfBelowCap("a".repeat(22), blobOf(40), T0 + 1000, T0, 1)).toBe(true);
    expect(await store.insertIfBelowCap("b".repeat(22), blobOf(40), T0 + 1000, T0, 1)).toBe(false);
    // The first row is expired at T0+1000, so it no longer counts and cannot be taken.
    expect(await store.exists("a".repeat(22), T0 + 999)).toBe(true);
    expect(await store.exists("a".repeat(22), T0 + 1000)).toBe(false);
    expect(await store.take("a".repeat(22), T0 + 1000)).toBeNull();
    expect(await store.insertIfBelowCap("b".repeat(22), blobOf(40), T0 + 5000, T0 + 1000, 1)).toBe(true);
  });

  it("exists does not delete, purgeExpired deletes only expired rows", async () => {
    await store.insertIfBelowCap("a".repeat(22), blobOf(40), T0 + 1000, T0, 10);
    await store.insertIfBelowCap("b".repeat(22), blobOf(40), T0 + 9000, T0, 10);
    expect(await store.exists("b".repeat(22), T0)).toBe(true);
    expect(await store.exists("b".repeat(22), T0)).toBe(true);
    await store.purgeExpired(T0 + 1000);
    const ids = (store.db.prepare("SELECT id FROM secrets").all() as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual(["b".repeat(22)]);
  });

  it("ping works and close is idempotent", async () => {
    await store.ping();
    await store.close();
    await store.close();
  });

  it("checkpoints the WAL into the main file on close", async () => {
    await store.insertIfBelowCap("a".repeat(22), blobOf(500), T0 + 1000, T0, 10);
    await store.close();
    const wal = `${dbPath}-wal`;
    expect(!existsSync(wal) || statSync(wal).size === 0).toBe(true);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  });

  it("refuses a second connection while the first is open, and accepts one after close", async () => {
    expect(() => openSqliteStore(dbPath, migrations())).toThrow(StoreLockedError);
    await store.close();
    const again = openSqliteStore(dbPath, migrations());
    await again.close();
  });

  it("creates no -shm file", () => {
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  });

  it("creates the directory with mode 0700 and the files with mode 0600 under umask 077", async () => {
    await store.close();
    const old = process.umask(0o077);
    try {
      const nested = join(dir.path, "a", "b");
      const p = join(nested, "x.db");
      const s = openSqliteStore(p, migrations());
      await s.insertIfBelowCap("a".repeat(22), blobOf(40), T0 + 1000, T0, 10);
      expect(statSync(nested).mode & 0o777).toBe(0o700);
      expect(statSync(p).mode & 0o777).toBe(0o600);
      expect(statSync(`${p}-wal`).mode & 0o777).toBe(0o600);
      await s.close();
    } finally {
      process.umask(old);
    }
  });
});

describe("a second process", () => {
  let dir: ReturnType<typeof tempDir>;
  let script: string;
  beforeAll(async () => {
    dir = tempDir("onetime-child-");
    script = join(dir.path, "child.mjs");
    const entry = join(dir.path, "child.ts");
    writeFileSync(
      entry,
      `import { openSqliteStore, StoreLockedError } from ${JSON.stringify(join(import.meta.dirname, "../../server/store-sqlite.ts"))};
import { readMigrations } from ${JSON.stringify(join(import.meta.dirname, "../../server/migrate.ts"))};
try {
  const s = openSqliteStore(process.argv[2], readMigrations(${JSON.stringify(MIGRATIONS_DIR)}));
  await s.close();
  console.log("opened");
} catch (e) {
  console.log(e instanceof StoreLockedError ? "locked" : "error " + e);
  process.exit(e instanceof StoreLockedError ? 3 : 1);
}
`,
    );
    await build({ entryPoints: [entry], outfile: script, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent" });
  });
  afterAll(() => dir.remove());

  const run = (db: string) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, ["--no-warnings", script, db]);
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.on("close", (code) => resolve({ code, out: out.trim() }));
    });

  it("fails with StoreLockedError while the first holds the file, then succeeds after close", async () => {
    const db = join(dir.path, "shared.db");
    const first = openSqliteStore(db, readMigrations(MIGRATIONS_DIR));
    const refused = await run(db);
    expect(refused).toEqual({ code: 3, out: "locked" });
    await first.close();
    expect(await run(db)).toEqual({ code: 0, out: "opened" });
  });
});

describe("migrations", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => void (dir = tempDir()));
  afterEach(() => dir.remove());

  it("reads the real migration folder sorted by name", () => {
    const list = readMigrations(MIGRATIONS_DIR);
    expect(list.map((m) => m.name)).toEqual([...list.map((m) => m.name)].sort());
    expect(list[0]?.name).toBe("0001_init.sql");
    expect(list[0]?.sql).toContain("CREATE TABLE secrets");
  });

  it("applies each migration once, tracked by user_version, and a reopen is a no-op", async () => {
    const dbPath = join(dir.path, "m.db");
    const list = [
      { name: "0001_a.sql", sql: "CREATE TABLE a (x INTEGER);" },
      { name: "0002_b.sql", sql: "CREATE TABLE b (x INTEGER);" },
    ];
    const s1 = openSqliteStore(dbPath, list.slice(0, 1));
    expect(s1.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    await s1.close();

    const s2 = openSqliteStore(dbPath, list);
    expect(s2.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    await s2.close();

    // Re-applying 0001 would throw "table a already exists".
    const s3 = openSqliteStore(dbPath, list);
    expect(s3.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    await s3.close();
  });

  it("rolls a failing migration back and does not advance user_version", async () => {
    const dbPath = join(dir.path, "f.db");
    const bad = [{ name: "0001_bad.sql", sql: "CREATE TABLE ok (x INTEGER); SELECT * FROM nope;" }];
    expect(() => openSqliteStore(dbPath, bad)).toThrow();
    const good = openSqliteStore(dbPath, [{ name: "0001_ok.sql", sql: "CREATE TABLE ok (x INTEGER);" }]);
    expect(good.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    await good.close();
  });

  it("readMigrations ignores non-sql files and sorts numerically by name", () => {
    mkdirSync(join(dir.path, "m"));
    for (const n of ["0002_b.sql", "0010_c.sql", "0001_a.sql", "notes.txt"]) writeFileSync(join(dir.path, "m", n), "SELECT 1;");
    expect(readMigrations(join(dir.path, "m")).map((m) => m.name)).toEqual(["0001_a.sql", "0002_b.sql", "0010_c.sql"]);
    expect(readdirSync(join(dir.path, "m"))).toContain("notes.txt");
    chmodSync(join(dir.path, "m"), 0o700);
  });
});
