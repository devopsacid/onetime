import { FILE_MAX_TTL_SECONDS, MAX_FILE_BYTES } from "../shared/limits";
import { ApiError } from "./api";
import { formatBytes, riskyFile } from "./filename";

/** DOM-free decisions for the file mode of the create view and for the revealed-file view. */

export const FILE_TTL_VALUES: readonly number[] = [3600, FILE_MAX_TTL_SECONDS];

export function checkFileSize(size: number): string | null {
  if (size === 0) return "The file is empty.";
  if (size > MAX_FILE_BYTES) return `Files can be at most ${formatBytes(MAX_FILE_BYTES)}.`;
  return null;
}

export function ttlOptionsFor(mode: "text" | "file", all: readonly number[]): number[] {
  return mode === "file" ? all.filter((value) => FILE_TTL_VALUES.includes(value)) : [...all];
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
