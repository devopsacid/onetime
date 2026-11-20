/** Limits shared by the browser app and the Worker. */

/** Largest secret (UTF-8 bytes) the app accepts. */
export const MAX_SECRET_BYTES = 16 * 1024;

/** v1 overhead: 12-byte IV in front, 16-byte tag at the end. The router refuses blobs of this size or less. */
export const BLOB_OVERHEAD_BYTES = 12 + 16;

/** Largest text blob: the largest v2 text blob (2 + 12 + padded block + 16); also covers v1 (16,412). Blobs above this are "large". */
export const MAX_TEXT_BLOB_BYTES = MAX_SECRET_BYTES + 4 + 14 + 16;

/**
 * Largest file (bytes of content) the hosted service stores: 256 KiB, and the default of a self-hosted server. The A0 spike
 * (docs/plans/file-transfer.md, Deviations) lost a reveal to error 1102 at this size before the reveal path was made cheaper,
 * so a re-spike is required before the hosted deploy. Self-hosted servers can raise it (ONETIME_MAX_FILE_BYTES) up to
 * FORMAT_MAX_FILE_BYTES.
 */
export const MAX_FILE_BYTES = 256 * 1024;

/** Largest file the blob format can hold (FILE_BUCKETS' last block): 5 MiB. Readers accept up to this, so a link is never unopenable. */
export const FORMAT_MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Largest file meta in the payload: 4-byte length prefix + 1 + 255 (name) + 1 + 127 (type). */
export const FILE_META_MAX = 4 + 1 + 255 + 1 + 127;

/** Padded block sizes of file blobs. The first three equal v2 text buckets; above 16 KiB they double up to 4 MiB, then 5 MiB, meta on top. */
export const FILE_BUCKETS = [
  1024,
  4096,
  MAX_SECRET_BYTES + 4,
  ...[64, 128, 256, 512, 1024, 2048, 4096, 5120].map((k) => k * 1024 + FILE_META_MAX),
] as const;

/** Largest blob the format allows (5,243,298): what readers accept from a reveal. */
export const FORMAT_MAX_BLOB_BYTES = FILE_BUCKETS[FILE_BUCKETS.length - 1]! + 14 + 16;

/** Largest blob the hosted router reads and stores (262,562): the file blob of MAX_FILE_BYTES; equals fileBlobBytes(MAX_FILE_BYTES). */
export const MAX_BLOB_BYTES = FILE_BUCKETS[5]! + 14 + 16;

/** Smallest blob size whose block holds a file of `maxFile` bytes with maximal meta. Throws RangeError outside 1..format maximum. */
export function fileBlobBytes(maxFile: number): number {
  const bucket = FILE_BUCKETS.find((size) => size >= maxFile + FILE_META_MAX);
  if (!Number.isInteger(maxFile) || maxFile < 1 || bucket === undefined) throw new RangeError("File size out of range");
  return bucket + 14 + 16;
}

/** Blobs above MAX_TEXT_BLOB_BYTES (files) can last at most this long on the hosted service (409 with maxTtl otherwise): 1 hour. */
export const LARGE_MAX_TTL_SECONDS = 60 * 60;
/** The hosted limit for files, as clients assume it when a server does not answer GET /api/limits. */
export const FILE_MAX_TTL_SECONDS = LARGE_MAX_TTL_SECONDS;
/** All stored blobs together; the capped insert refuses beyond this. */
export const MAX_STORED_BYTES = 400_000_000;
/** Large blobs insert only while the total stays at or below this; the rest is reserved for texts. */
export const MAX_LARGE_STORED_BYTES = 200_000_000;

export const MIN_TTL_SECONDS = 60;
export const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
export const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

/** Global safety valve: create returns 503 while this many unexpired secrets are stored. */
export const MAX_STORED_SECRETS = 20_000;

/** While the store is above 80 % of the cap, links may last at most this long (409 otherwise). */
export const NEAR_FULL_MAX_TTL_SECONDS = 24 * 60 * 60;

/** Cap for creates with a TTL above NEAR_FULL_MAX_TTL_SECONDS: 80 % of the cap, at least 1. */
export function longTtlCap(maxStored: number): number {
  return Math.max(1, Math.floor((maxStored * 4) / 5));
}

/** Secret ids are 16 random bytes in base64url. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
/** Keys are 32 random bytes in base64url. */
export const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Length of the padded block (4-byte length prefix, secret, zero bytes) in a v2 blob; see docs/plans/blob-v2.md. */
export const V2_BUCKETS = [256, 1024, 4096, MAX_SECRET_BYTES + 4] as const;

/** Link format prefix of v2 links: "2", "2p" (passphrase), "2f" (file) or "2fp" (file with passphrase). */
export const FORMAT_PATTERN = /^2f?p?$/;

/** What GET /api/limits answers: the file size and file lifetime this server accepts, and the text size. */
export interface ServerLimits {
  /** Largest file in bytes; 0 = files are off on this server. */
  maxFileBytes: number;
  /** Longest life of a blob above MAX_TEXT_BLOB_BYTES (a file), in seconds. */
  maxFileTtl: number;
  maxTextBytes: number;
}

/** The hosted service's limits: what a client assumes when a server has no /api/limits (an older server). */
export const HOSTED_LIMITS: ServerLimits = { maxFileBytes: MAX_FILE_BYTES, maxFileTtl: FILE_MAX_TTL_SECONDS, maxTextBytes: MAX_SECRET_BYTES };

const intIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

/** Validates a /api/limits reply from an untrusted server; null when anything is missing or out of range. Extra fields are ignored. */
export function parseLimits(value: unknown): ServerLimits | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { maxFileBytes, maxFileTtl, maxTextBytes } = value as Record<string, unknown>;
  if (!intIn(maxFileBytes, 0, FORMAT_MAX_FILE_BYTES)) return null;
  if (!intIn(maxFileTtl, MIN_TTL_SECONDS, MAX_TTL_SECONDS)) return null;
  if (!intIn(maxTextBytes, 1, MAX_SECRET_BYTES)) return null;
  return { maxFileBytes, maxFileTtl, maxTextBytes };
}
