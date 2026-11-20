import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CounterMissingError, type SecretStore } from "../src/worker/store";
import { applyMigrations, type Migration } from "./migrate";

export type { Migration };

export interface ManagedStore extends SecretStore {
  /** For /healthz: the database answers and the stats counter row exists (throws CounterMissingError otherwise). */
  ping(): Promise<void>;
  /** Checkpoint (TRUNCATE) and close; idempotent. */
  close(): Promise<void>;
}

/** The store plus its connection, which tests use to look at rows. With the exclusive lock no other connection can. */
export interface SqliteStore extends ManagedStore {
  readonly db: DatabaseSync;
}

/** Another process (or connection) holds the database file. */
export class StoreLockedError extends Error {
  constructor(path: string) {
    super(`The database ${path} is locked by another process. Only one onetime server may use it.`);
    this.name = "StoreLockedError";
  }
}

type SqliteModule = typeof import("node:sqlite") & { Database?: typeof DatabaseSync };

function loadSqlite(): SqliteModule {
  const mod = process.getBuiltinModule?.("node:sqlite") as SqliteModule | undefined;
  if (!mod) throw new Error("node:sqlite is not available. Node 22.13 or newer is required.");
  return mod;
}

function isBusy(error: unknown): boolean {
  const e = error as { errcode?: number; message?: string };
  return e.errcode === 5 || e.errcode === 6 || /database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(e.message ?? "");
}

function toBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (!(value instanceof Uint8Array)) throw new Error("Unexpected blob type");
  // Copy: the driver may hand out a view into a shared pool.
  return new Uint8Array(value);
}

/** Opens (creating if needed) the database, takes the process-wide write lock for good and applies migrations. */
export function openSqliteStore(path: string, migrations: Migration[]): SqliteStore {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const sqlite = loadSqlite();
  const Database = sqlite.Database ?? sqlite.DatabaseSync;
  const db = new Database(path);
  try {
    // Fail fast when another process holds the file; the longer timeout comes after the lock is ours.
    db.exec("PRAGMA busy_timeout = 0");
    try {
      // Exclusive first: SQLite then keeps the WAL index in memory (no -shm) and never gives the lock back.
      db.exec("PRAGMA locking_mode = EXCLUSIVE");
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("BEGIN IMMEDIATE; COMMIT");
    } catch (error) {
      if (isBusy(error)) throw new StoreLockedError(path);
      throw error;
    }
    db.exec("PRAGMA busy_timeout = 5000");
    // FULL: with NORMAL a power loss could bring a revealed secret back.
    db.exec("PRAGMA synchronous = FULL");
    db.exec("PRAGMA secure_delete = ON");
    db.exec("PRAGMA temp_store = MEMORY");
    db.exec("PRAGMA journal_size_limit = 4194304");
    applyMigrations(db, migrations);
  } catch (error) {
    db.close();
    throw error;
  }

  // Prepared on first use, so a database without the secrets table (migration tests) can still open.
  const lazy = (sql: string) => {
    let statement: ReturnType<DatabaseSync["prepare"]> | undefined;
    return () => (statement ??= db.prepare(sql));
  };
  const insert = lazy(
    "INSERT INTO secrets (id, blob, expires_at) SELECT ?1, ?2, ?3 WHERE (SELECT stored < ?4 AND bytes + length(?2) <= ?5 FROM stats WHERE id = 1)",
  );
  const take = lazy("DELETE FROM secrets WHERE id = ? AND expires_at > ? RETURNING blob");
  const exists = lazy("SELECT 1 AS found FROM secrets WHERE id = ? AND expires_at > ?");
  const purge = lazy("DELETE FROM secrets WHERE expires_at <= ?");
  const counter = lazy("SELECT 1 AS found FROM stats WHERE id = 1");
  let closed = false;

  return {
    db,
    async insertIfBelowCap(id, blob, expiresAt, maxStored, maxBytes) {
      if (Number(insert().run(id, blob, expiresAt, maxStored, maxBytes).changes) !== 0) return true;
      // Refused: full, or the counter row is missing (the subquery is then NULL). One cheap read tells them apart.
      if (counter().get() === undefined) throw new CounterMissingError();
      return false;
    },
    async take(id, now) {
      const row = take().get(id, now) as { blob: unknown } | undefined;
      return row === undefined ? null : toBytes(row.blob);
    },
    async exists(id, now) {
      return exists().get(id, now) !== undefined;
    },
    async purgeExpired(now) {
      // node:sqlite is synchronous. The router starts purges with waitUntil() before it returns its response, so the
      // purge waits one turn of the event loop: the response is written first, then the rows go.
      await new Promise<void>((resolve) => setImmediate(resolve));
      purge().run(now);
    },
    async ping() {
      // The counter row is part of health: without it every create would fail.
      if (counter().get() === undefined) throw new CounterMissingError();
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } finally {
        db.close();
      }
    },
  };
}
