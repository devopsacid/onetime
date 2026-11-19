import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Migration {
  name: string;
  sql: string;
}

/** Reads `*.sql` files from a folder, sorted by file name. The folder is fixed by the operator, never by a request. */
export function readMigrations(dir: string): Migration[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

/** The subset of node:sqlite this module uses, so it does not depend on the module's types. */
export interface Execer {
  exec(sql: string): void;
  prepare(sql: string): { get(): unknown };
}

/**
 * Applies migrations that have not run yet. `PRAGMA user_version` holds how many ran, and it changes in the same
 * transaction as the migration, so a failing migration leaves the database as it was.
 */
export function applyMigrations(db: Execer, migrations: Migration[]): void {
  const done = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let i = done; i < migrations.length; i++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migrations[i]!.sql);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
