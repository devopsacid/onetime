import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMigrations } from "../../server/migrate";

export const MIGRATIONS_DIR = join(import.meta.dirname, "..", "..", "migrations");
export const migrations = () => readMigrations(MIGRATIONS_DIR);

/** A fresh temp directory under ~/.tmp-like space; the caller removes it. */
export function tempDir(prefix = "onetime-test-"): { path: string; remove(): void } {
  const base = process.env.ONETIME_TEST_TMP ?? tmpdir();
  mkdirSync(base, { recursive: true });
  const path = mkdtempSync(join(base, prefix));
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}
