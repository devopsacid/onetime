import { constants } from "node:fs";
import { lstat, open, stat, unlink } from "node:fs/promises";

/** What is at `path`, following symlinks. A dangling symlink counts as "file": it exists and must not be written through. */
export async function statPath(path: string): Promise<"dir" | "file" | "missing"> {
  try {
    return (await stat(path)).isDirectory() ? "dir" : "file";
  } catch {
    try {
      await lstat(path);
      return "file";
    } catch {
      return "missing";
    }
  }
}

/**
 * Creates `path` with O_CREAT | O_EXCL | O_WRONLY and mode 0600, then writes `bytes`. O_EXCL means an existing file, and
 * any symlink at the final component (even a dangling one), makes it fail with EEXIST instead of writing through.
 * A failure after the file was created rejects with `partial: true`; the caller removes it.
 */
export async function writeFileExclusive(path: string, bytes: Uint8Array): Promise<void> {
  const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset);
      offset += bytesWritten;
    }
  } catch (error) {
    throw Object.assign(error as Error, { partial: true });
  } finally {
    await file.close().catch(() => {});
  }
}

export async function removeFile(path: string): Promise<void> {
  await unlink(path);
}

/** Reads at most `max + 1` bytes of a file (the core rejects the overflow); rejects when it cannot be read. */
export async function readFileBytes(path: string, max: number): Promise<Uint8Array> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(max + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    return buffer.subarray(0, total);
  } finally {
    await file.close();
  }
}
