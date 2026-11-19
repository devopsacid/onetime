import { statSync } from "node:fs";
import { dirname } from "node:path";

const mode = (path: string): number | null => {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
};
const octal = (m: number) => m.toString(8).padStart(3, "0");

/**
 * One line (or null) about a database folder or file that other users can reach. The stored blobs are encrypted and
 * the keys never reach the server, but the files are meant to be private, and an existing folder (a Docker volume, a
 * directory made by hand) keeps the mode it already had. The server only warns; it never changes modes itself.
 */
export function permissionWarning(dbPath: string, platform: string = process.platform): string | null {
  if (platform === "win32") return null;
  const found: string[] = [];
  const dir = dirname(dbPath);
  const dirMode = mode(dir);
  if (dirMode !== null && (dirMode & 0o077) !== 0) found.push(`folder ${dir} has mode ${octal(dirMode)}`);
  for (const file of [dbPath, `${dbPath}-wal`]) {
    const m = mode(file);
    if (m !== null && (m & 0o077) !== 0) found.push(`${file} has mode ${octal(m)}`);
  }
  if (found.length === 0) return null;
  return `onetime: warning: ${found.join("; ")}; other users may be able to read the database. Use "chmod 700" on the folder and "chmod 600" on the files.`;
}
