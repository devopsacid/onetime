import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readMigrations } from "../../server/migrate";
import { CounterMissingError } from "../../src/worker/store";
import { openSqliteStore, StoreLockedError, type SqliteStore } from "../../server/store-sqlite";
import { expectAtomicSql, type IssuedSql } from "../contract/api-contract";
import { MIGRATIONS_DIR, migrations, tempDir, trackChild } from "./helpers";

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

  it("issues exactly one DELETE ... RETURNING for a reveal and one capped INSERT, and no SELECT-then-DELETE", async () => {
    let into: string[] = [];
    const real = store.db.prepare.bind(store.db);
    store.db.prepare = ((sql: string) => (into.push(sql), real(sql))) as typeof store.db.prepare;
    const realExec = store.db.exec.bind(store.db);
    store.db.exec = ((sql: string) => (into.push(sql), realExec(sql))) as typeof store.db.exec;
    const issued: IssuedSql = { reveal: [], insert: [] };
    await store.insertIfBelowCap("a".repeat(22), blobOf(40), T0 + 60_000, 10, 1_000_000);
    issued.insert = into;
    into = [];
    expect(await store.take("a".repeat(22), T0)).not.toBeNull();
    issued.reveal = into;
    expectAtomicSql(issued);
  });

  it("round-trips every byte value", async () => {
    const blob = new Uint8Array(256);
    for (let i = 0; i < 256; i++) blob[i] = i;
    expect(await store.insertIfBelowCap("a".repeat(22), blob, T0 + 1000, 10, 1_000_000)).toBe(true);
    const back = await store.take("a".repeat(22), T0);
    expect(back).toEqual(blob);
    expect(back!.buffer).toBeInstanceOf(ArrayBuffer);
    expect(await store.take("a".repeat(22), T0)).toBeNull();
  });

  it("honours the cap (stored rows) and expiry in the store itself", async () => {
    expect(await store.insertIfBelowCap("a".repeat(22), blobOf(40), T0 + 1000, 1, 1_000_000)).toBe(true);
    expect(await store.insertIfBelowCap("b".repeat(22), blobOf(40), T0 + 1000, 1, 1_000_000)).toBe(false);
    // The first row is expired at T0+1000 and cannot be taken. It still counts until a purge removes it.
    expect(await store.exists("a".repeat(22), T0 + 999)).toBe(true);
    expect(await store.exists("a".repeat(22), T0 + 1000)).toBe(false);
    expect(await store.take("a".repeat(22), T0 + 1000)).toBeNull();
    expect(await store.insertIfBelowCap("b".repeat(22), blobOf(40), T0 + 5000, 1, 1_000_000)).toBe(false);
    await store.purgeExpired(T0 + 1000);
    expect(await store.insertIfBelowCap("b".repeat(22), blobOf(40), T0 + 5000, 1, 1_000_000)).toBe(true);
  });

  it("exists does not delete, purgeExpired deletes only expired rows", async () => {
    await store.insertIfBelowCap("a".repeat(22), blobOf(40), T0 + 1000, 10, 1_000_000);
    await store.insertIfBelowCap("b".repeat(22), blobOf(40), T0 + 9000, 10, 1_000_000);
    expect(await store.exists("b".repeat(22), T0)).toBe(true);
    expect(await store.exists("b".repeat(22), T0)).toBe(true);
    await store.purgeExpired(T0 + 1000);
    const ids = (store.db.prepare("SELECT id FROM secrets").all() as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual(["b".repeat(22)]);
  });

  it("insertIfBelowCap throws CounterMissingError instead of reporting full when the counter row is gone", async () => {
    store.db.prepare("DELETE FROM stats WHERE id = 1").run();
    await expect(store.insertIfBelowCap("a".repeat(22), blobOf(40), T0 + 1000, 10, 1_000_000)).rejects.toThrow(CounterMissingError);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM secrets").get()).toEqual({ n: 0 });
  });

  it("ping fails when the counter row is missing and works when it is back", async () => {
    await store.ping();
    store.db.prepare("DELETE FROM stats WHERE id = 1").run();
    await expect(store.ping()).rejects.toThrow(CounterMissingError);
    store.db.prepare("INSERT INTO stats (id, stored, bytes) SELECT 1, COUNT(*), COALESCE(SUM(length(blob)), 0) FROM secrets").run();
    await store.ping();
  });

  it("the documented repair statement fixes a drifted counter", async () => {
    await store.insertIfBelowCap("a".repeat(22), blobOf(40), T0 + 1000, 10, 1_000_000);
    store.db.prepare("UPDATE stats SET stored = 99 WHERE id = 1").run();
    store.db.prepare("UPDATE stats SET bytes = 12345 WHERE id = 1").run();
    store.db
      .prepare("UPDATE stats SET stored = (SELECT COUNT(*) FROM secrets), bytes = (SELECT COALESCE(SUM(length(blob)), 0) FROM secrets) WHERE id = 1")
      .run();
    expect(store.db.prepare("SELECT stored, bytes FROM stats WHERE id = 1").get()).toEqual({ stored: 1, bytes: 40 });
  });

  it("ping works and close is idempotent", async () => {
    await store.ping();
    await store.close();
    await store.close();
  });

  it("checkpoints the WAL into the main file on close", async () => {
    await store.insertIfBelowCap("a".repeat(22), blobOf(500), T0 + 1000, 10, 1_000_000);
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
      await s.insertIfBelowCap("a".repeat(22), blobOf(40), T0 + 1000, 10, 1_000_000);
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
      const child = trackChild(spawn(process.execPath, ["--no-warnings", script, db]));
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

  it("seeds stats.stored from the rows of a version-1 database and keeps it exact with triggers", async () => {
    const dbPath = join(dir.path, "seed.db");
    const all = migrations();
    expect(all.map((m) => m.name)).toEqual(["0001_init.sql", "0002_counter.sql", "0003_bytes.sql"]);
    const v1 = openSqliteStore(dbPath, all.slice(0, 1));
    for (let i = 0; i < 7; i++) v1.db.prepare("INSERT INTO secrets (id, blob, expires_at) VALUES (?, ?, ?)").run(`id${i}`, new Uint8Array(40), i < 3 ? 1 : 9_000_000_000_000);
    expect(v1.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    await v1.close();

    const v2 = openSqliteStore(dbPath, all.slice(0, 2));
    expect(v2.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    // Expired-but-unpurged rows count: the counter is the number of stored rows.
    expect(v2.db.prepare("SELECT stored FROM stats WHERE id = 1").get()).toEqual({ stored: 7 });

    await v2.purgeExpired(2);
    expect(v2.db.prepare("SELECT stored FROM stats WHERE id = 1").get()).toEqual({ stored: 4 });
    expect(await v2.take("id5", 2)).not.toBeNull();
    expect(v2.db.prepare("SELECT stored FROM stats WHERE id = 1").get()).toEqual({ stored: 3 });
    expect(() => v2.db.prepare("INSERT INTO stats (id, stored) VALUES (2, 0)").run()).toThrow();
    await v2.close();
  });

  it("0003 gives a version-2 database exact byte and row counters, replaces the triggers and keeps them exact", async () => {
    const dbPath = join(dir.path, "bytes.db");
    const all = migrations();
    const v2 = openSqliteStore(dbPath, all.slice(0, 2));
    const sizes = [40, 300, 16_418, 70_000, 5];
    sizes.forEach((n, i) =>
      v2.db.prepare("INSERT INTO secrets (id, blob, expires_at) VALUES (?, ?, ?)").run(`id${i}`, new Uint8Array(n), i < 2 ? 1 : 9_000_000_000_000),
    );
    // A drifted counter from before: the migration must reset it, not trust it.
    v2.db.prepare("UPDATE stats SET stored = 99 WHERE id = 1").run();
    await v2.close();

    const v3 = openSqliteStore(dbPath, all);
    expect(v3.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    const total = sizes.reduce((a, b) => a + b, 0);
    expect(v3.db.prepare("SELECT stored, bytes FROM stats WHERE id = 1").get()).toEqual({ stored: 5, bytes: total });
    const triggers = (v3.db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(triggers).toEqual(["secrets_stats_delete", "secrets_stats_insert"]);

    await v3.purgeExpired(2); // removes the 40 and 300 byte rows
    expect(v3.db.prepare("SELECT stored, bytes FROM stats WHERE id = 1").get()).toEqual({ stored: 3, bytes: total - 340 });
    expect(await v3.take("id3", 2)).toHaveLength(70_000);
    expect(v3.db.prepare("SELECT stored, bytes FROM stats WHERE id = 1").get()).toEqual({ stored: 2, bytes: 16_418 + 5 });
    expect(await v3.insertIfBelowCap("n".repeat(22), blobOf(100), 9_000_000_000_000, 10, 16_423 + 99)).toBe(false);
    expect(await v3.insertIfBelowCap("n".repeat(22), blobOf(100), 9_000_000_000_000, 10, 16_423 + 100)).toBe(true);
    expect(v3.db.prepare("SELECT stored, bytes FROM stats WHERE id = 1").get()).toEqual({ stored: 3, bytes: 16_523 });
    await v3.close();
  });

  it("0003 on an empty version-2 database starts both counters at zero", async () => {
    const dbPath = join(dir.path, "empty.db");
    const s = openSqliteStore(dbPath, migrations());
    expect(s.db.prepare("SELECT stored, bytes FROM stats WHERE id = 1").get()).toEqual({ stored: 0, bytes: 0 });
    await s.close();
  });

  it("readMigrations ignores non-sql files and sorts numerically by name", () => {
    mkdirSync(join(dir.path, "m"));
    for (const n of ["0002_b.sql", "0010_c.sql", "0001_a.sql", "notes.txt"]) writeFileSync(join(dir.path, "m", n), "SELECT 1;");
    expect(readMigrations(join(dir.path, "m")).map((m) => m.name)).toEqual(["0001_a.sql", "0002_b.sql", "0010_c.sql"]);
  });
});
