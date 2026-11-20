import { MAX_SECRET_BYTES, V2_BUCKETS } from "../shared/limits";

const PREFIX_BYTES = 4;

/** Length prefix (uint32, big endian), the secret, then zero bytes up to the smallest bucket that fits. */
export function pad(secret: Uint8Array): Uint8Array<ArrayBuffer> {
  if (secret.length > MAX_SECRET_BYTES) throw new RangeError("Secret too large");
  const bucket = V2_BUCKETS.find((size) => size >= secret.length + PREFIX_BYTES);
  if (bucket === undefined) throw new RangeError("Secret too large");
  const out = new Uint8Array(bucket);
  new DataView(out.buffer).setUint32(0, secret.length, false);
  out.set(secret, PREFIX_BYTES);
  return out;
}

/** Inverse of pad. Throws on a wrong block size, an impossible length or nonzero padding. */
export function unpad(inner: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!(V2_BUCKETS as readonly number[]).includes(inner.length)) throw new Error("Bad block size");
  const length = new DataView(inner.buffer, inner.byteOffset, inner.byteLength).getUint32(0, false);
  if (length > inner.length - PREFIX_BYTES || length > MAX_SECRET_BYTES) throw new Error("Bad length");
  for (let i = PREFIX_BYTES + length; i < inner.length; i++) {
    if (inner[i] !== 0) throw new Error("Bad padding");
  }
  return inner.slice(PREFIX_BYTES, PREFIX_BYTES + length);
}
