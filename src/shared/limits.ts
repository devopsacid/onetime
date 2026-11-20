/** Limits shared by the browser app and the Worker. */

/** Largest secret (UTF-8 bytes) the app accepts. */
export const MAX_SECRET_BYTES = 16 * 1024;

/** v1 overhead: 12-byte IV in front, 16-byte tag at the end. The router refuses blobs of this size or less. */
export const BLOB_OVERHEAD_BYTES = 12 + 16;

/** Largest text blob: the largest v2 text blob (2 + 12 + padded block + 16); also covers v1 (16,412). Blobs above this are "large". */
export const MAX_TEXT_BLOB_BYTES = MAX_SECRET_BYTES + 4 + 14 + 16;

/** Hosted writer limit for files (bytes of content). The spike (docs/plans/file-transfer.md A0) may lower it with this one line; the format allows up to FILE_BUCKETS' last block. */
export const MAX_FILE_BYTES = 1024 * 1024;

/** Largest file meta in the payload: 4-byte length prefix + 1 + 255 (name) + 1 + 127 (type). */
export const FILE_META_MAX = 4 + 1 + 255 + 1 + 127;

/** Padded block sizes of file blobs. The first three equal v2 text buckets; above 16 KiB they double, meta on top. */
export const FILE_BUCKETS = [1024, 4096, MAX_SECRET_BYTES + 4, ...[64, 128, 256, 512, 1024].map((k) => k * 1024 + FILE_META_MAX)] as const;

/** Largest blob the router reads: the largest file blob the format allows (hosted limits may be lower, see fileBlobBytes). */
export const MAX_BLOB_BYTES = FILE_BUCKETS[FILE_BUCKETS.length - 1]! + 14 + 16;

/** Smallest blob size whose block holds a file of `maxFile` bytes with maximal meta. Throws RangeError outside 1..format maximum. */
export function fileBlobBytes(maxFile: number): number {
  const bucket = FILE_BUCKETS.find((size) => size >= maxFile + FILE_META_MAX);
  if (!Number.isInteger(maxFile) || maxFile < 1 || bucket === undefined) throw new RangeError("File size out of range");
  return bucket + 14 + 16;
}

/** Blobs above MAX_TEXT_BLOB_BYTES can last at most this long (409 with maxTtl otherwise). */
export const LARGE_MAX_TTL_SECONDS = 24 * 60 * 60;
/** Client rule for every file. */
export const FILE_MAX_TTL_SECONDS = 24 * 60 * 60;
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
