import { ApiError } from "./api";
import { formatBytes, riskyFile } from "./filename";

/** DOM-free decisions for the file mode of the create view and for the revealed-file view. */

export function checkFileSize(size: number, maxFileBytes: number): string | null {
  if (maxFileBytes <= 0) return "This server does not accept files.";
  if (size === 0) return "The file is empty.";
  if (size > maxFileBytes) return `Files can be at most ${formatBytes(maxFileBytes)}.`;
  return null;
}

/** The expiry options a file may use: those not longer than the server's file lifetime. */
export function fileTtlValues(all: readonly number[], maxFileTtl: number): number[] {
  return all.filter((value) => value <= maxFileTtl);
}

export function ttlOptionsFor(mode: "text" | "file", all: readonly number[], maxFileTtl: number): number[] {
  return mode === "file" ? fileTtlValues(all, maxFileTtl) : [...all];
}

export function pickFileTtl(allowed: readonly number[]): number | null {
  return allowed.length === 0 ? null : Math.max(...allowed);
}

export function formatLifetime(seconds: number): string {
  const unit = (n: number, name: string) => `${n} ${name}${n === 1 ? "" : "s"}`;
  if (seconds % 86400 === 0) return unit(seconds / 86400, "day");
  if (seconds % 3600 === 0) return unit(seconds / 3600, "hour");
  return unit(Math.round(seconds / 60), "minute");
}

/** A file-specific message for a failed create, or null to use the generic handling (409 maxTtl, network). */
export function fileCreateError(error: unknown, file: boolean): string | null {
  if (!file || !(error instanceof ApiError)) return null;
  if (error.status === 413) return "This server does not accept files this large.";
  if (error.status === 503) return "There is no room for files right now. Try again later or send a smaller file.";
  return null;
}

export function progressPercent(loaded: number, total: number | null): number | null {
  if (total === null || total <= 0) return null;
  return Math.min(100, Math.floor((loaded / total) * 100));
}

export function uploadLabel(bytes: number): string {
  return `Uploading ${formatBytes(bytes)}…`;
}

export function describeFile(file: { name: string; type: string; size: number }): {
  name: string;
  size: string;
  type: string;
  risky: boolean;
} {
  return { name: file.name, size: formatBytes(file.size), type: file.type, risky: riskyFile(file.name) };
}
