/** Limits shared by the browser app and the Worker. */

/** Largest secret (UTF-8 bytes) the app accepts. */
export const MAX_SECRET_BYTES = 16 * 1024;

/** AES-GCM overhead: 12-byte IV in front, 16-byte tag at the end. */
export const BLOB_OVERHEAD_BYTES = 12 + 16;

/** Largest encrypted blob the Worker stores. */
export const MAX_BLOB_BYTES = MAX_SECRET_BYTES + BLOB_OVERHEAD_BYTES;

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

/** Link format prefix of v2 links: "2", or "2p" when a passphrase is needed. */
export const FORMAT_PATTERN = /^2p?$/;
