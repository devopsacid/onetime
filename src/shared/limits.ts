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

/** Secret ids are 16 random bytes in base64url. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
/** Keys are 32 random bytes in base64url. */
export const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
