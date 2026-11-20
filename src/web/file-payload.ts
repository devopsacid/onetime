import { MAX_FILE_BYTES } from "../shared/limits";
import { cleanMime, safeFileName } from "./filename";

/** What the sender gives and the receiver gets. The reader's name and type are already sanitised. */
export interface FileParts {
  name: string;
  type: string;
  bytes: Uint8Array<ArrayBuffer>;
}

/** Payload layout (docs/plans/file-transfer.md A-2): N, name (UTF-8), T, type (ASCII), content. */
export function encodeFilePayload(file: { name: string; type: string; bytes: Uint8Array }): Uint8Array<ArrayBuffer> {
  if (file.bytes.length === 0 || file.bytes.length > MAX_FILE_BYTES) throw new RangeError("File size out of range");
  const name = new TextEncoder().encode(safeFileName(file.name));
  const type = new TextEncoder().encode(cleanMime(file.type));
  const out = new Uint8Array(2 + name.length + type.length + file.bytes.length);
  out[0] = name.length; // 1 to 200 bytes
  out.set(name, 1);
  out[1 + name.length] = type.length; // 0 to 125
  out.set(type, 2 + name.length);
  out.set(file.bytes, 2 + name.length + type.length);
  return out;
}

function bad(): Error {
  return new Error("Bad file payload");
}

/** Throws on any layout violation. The returned name is safeFileName(stored name); the type is kept only if it is clean as stored. */
export function decodeFilePayload(payload: Uint8Array): FileParts {
  if (payload.length < 2) throw bad();
  const nameLength = payload[0]!;
  if (nameLength === 0 || 1 + nameLength + 1 > payload.length) throw bad();
  const typeLength = payload[1 + nameLength]!;
  if (typeLength > 127) throw bad();
  const contentStart = 2 + nameLength + typeLength;
  if (contentStart >= payload.length) throw bad(); // overrun, or empty content
  if (payload.length - contentStart > MAX_FILE_BYTES) throw bad();
  let name: string;
  try {
    name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(payload.subarray(1, 1 + nameLength));
  } catch {
    throw bad();
  }
  let type = "";
  try {
    type = new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(2 + nameLength, contentStart));
  } catch {
    // A type that is not text is simply not shown.
  }
  return {
    name: safeFileName(name),
    type: cleanMime(type) === type ? type : "",
    bytes: payload.slice(contentStart),
  };
}
