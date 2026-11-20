import { MAX_SECRET_BYTES, V2_BUCKETS } from "../shared/limits";

const PREFIX_BYTES = 4;

/** Length prefix (uint32, big endian), the payload, then zero bytes up to the smallest bucket that fits. Defaults to the text buckets. */
export function pad(payload: Uint8Array, buckets: readonly number[] = V2_BUCKETS): Uint8Array<ArrayBuffer> {
  const bucket = buckets.find((size) => size >= payload.length + PREFIX_BYTES);
  if (bucket === undefined) throw new RangeError("Secret too large");
  const out = new Uint8Array(bucket);
  new DataView(out.buffer).setUint32(0, payload.length, false);
  out.set(payload, PREFIX_BYTES);
  return out;
}

/** Inverse of pad. Throws on a wrong block size, an impossible length (above `maxPayload`) or nonzero padding. */
export function unpad(
  inner: Uint8Array,
  buckets: readonly number[] = V2_BUCKETS,
  maxPayload: number = MAX_SECRET_BYTES,
): Uint8Array<ArrayBuffer> {
  if (!buckets.includes(inner.length)) throw new Error("Bad block size");
  const length = new DataView(inner.buffer, inner.byteOffset, inner.byteLength).getUint32(0, false);
  if (length > inner.length - PREFIX_BYTES || length > maxPayload) throw new Error("Bad length");
  for (let i = PREFIX_BYTES + length; i < inner.length; i++) {
    if (inner[i] !== 0) throw new Error("Bad padding");
  }
  return inner.slice(PREFIX_BYTES, PREFIX_BYTES + length);
}
