import {
  BLOB_OVERHEAD_BYTES,
  ID_PATTERN,
  LARGE_MAX_TTL_SECONDS,
  MAX_FILE_BYTES,
  MAX_SECRET_BYTES,
  MAX_LARGE_STORED_BYTES,
  MAX_STORED_BYTES,
  MAX_STORED_SECRETS,
  MAX_TEXT_BLOB_BYTES,
  fileBlobBytes,
  NEAR_FULL_MAX_TTL_SECONDS,
  longTtlCap,
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
} from "../shared/limits";
import { CounterMissingError, type SecretStore, type WaitUntil } from "./store";

/**
 * Test hooks (fixed clock in ms since epoch, smaller caps) that the Node server also sets from its configuration.
 * `maxLargeBytes: 0` or `maxFileBytes: 0` turns large blobs (above MAX_TEXT_BLOB_BYTES) off. `maxFileBytes` is the
 * largest file (default MAX_FILE_BYTES) and `maxFileTtl` the longest life of a large blob in seconds (default
 * LARGE_MAX_TTL_SECONDS); GET /api/limits reports both. `maxBlobBytes` is the largest body read; it defaults to what
 * `maxFileBytes` allows (see `blobLimit`).
 */
export interface Options {
  now?: number;
  maxStored?: number;
  maxStoredBytes?: number;
  maxLargeBytes?: number;
  maxFileBytes?: number;
  maxFileTtl?: number;
  maxBlobBytes?: number;
}

/** Whether a router with these options accepts files: both the file size and the large-blob budget must be above 0. */
function filesOn(options: Pick<Options, "maxLargeBytes" | "maxFileBytes">): boolean {
  return (options.maxLargeBytes ?? MAX_LARGE_STORED_BYTES) > 0 && (options.maxFileBytes ?? MAX_FILE_BYTES) > 0;
}

/** The largest blob a router with these options reads: text only when files are off, else the file blob of `maxFileBytes`. */
export function blobLimit(options: Pick<Options, "maxLargeBytes" | "maxFileBytes" | "maxBlobBytes"> = {}): number {
  if (options.maxBlobBytes !== undefined) return options.maxBlobBytes;
  return filesOn(options) ? fileBlobBytes(options.maxFileBytes ?? MAX_FILE_BYTES) : MAX_TEXT_BLOB_BYTES;
}

export const API_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex",
  // Responses are bytes or JSON, never documents: nothing may load, frame or run from them.
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Cross-Origin-Resource-Policy": "same-origin",
};

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...API_HEADERS, ...extra } });
}

function error(status: number, message: string, extra: Record<string, string> = {}): Response {
  return json(status, { error: message }, extra);
}

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** Reads at most `limit` bytes; cancels the stream and returns null as soon as more arrive. */
async function readBounded(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  // One whole-buffer chunk needs no join copy (the stores bind `.buffer`, so a partial view must still be copied).
  const only = chunks.length === 1 ? chunks[0]! : null;
  if (only !== null && only.byteOffset === 0 && only.byteLength === only.buffer.byteLength && only.buffer instanceof ArrayBuffer) {
    return only as Uint8Array<ArrayBuffer>;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

interface Caps {
  maxStored: number;
  maxStoredBytes: number;
  maxLargeBytes: number;
  maxFileTtl: number;
  maxBlob: number;
}

/** "1 hour", "1 day" or "N seconds" for the 409 message. */
function describeSeconds(seconds: number): string {
  if (seconds % 86400 === 0) return seconds === 86400 ? "1 day" : `${seconds / 86400} days`;
  if (seconds % 3600 === 0) return seconds === 3600 ? "1 hour" : `${seconds / 3600} hours`;
  return `${seconds} seconds`;
}

async function createSecret(request: Request, store: SecretStore, url: URL, now: number, caps: Caps): Promise<Response> {
  if (request.headers.get("Content-Type") !== "application/octet-stream") {
    return error(415, "Body must be application/octet-stream");
  }

  const ttlParam = url.searchParams.get("ttl") ?? "";
  const ttl = /^\d+$/.test(ttlParam) ? Number(ttlParam) : NaN;
  if (!Number.isSafeInteger(ttl) || ttl < MIN_TTL_SECONDS || ttl > MAX_TTL_SECONDS) {
    return error(400, "Invalid ttl");
  }

  // Early refusal for an honest Content-Length; the stream reader below enforces the real limit.
  const declared = request.headers.get("Content-Length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > caps.maxBlob) {
    return error(413, "Secret is too large");
  }

  const blob = await readBounded(request.body, caps.maxBlob);
  if (blob === null) return error(413, "Secret is too large");
  if (blob.byteLength <= BLOB_OVERHEAD_BYTES) return error(400, "Invalid secret size");

  // The server cannot tell files from texts, so the rules go by size: only blobs above the largest text blob are large.
  const large = blob.byteLength > MAX_TEXT_BLOB_BYTES;
  if (large && ttl > caps.maxFileTtl) {
    return json(409, { error: `Secrets larger than 16 KB can last at most ${describeSeconds(caps.maxFileTtl)}.`, maxTtl: caps.maxFileTtl });
  }

  await store.purgeExpired(now);

  const id = newId();
  let stored: boolean;
  const longTtl = ttl > NEAR_FULL_MAX_TTL_SECONDS;
  const rowCap = longTtl ? longTtlCap(caps.maxStored) : caps.maxStored;
  const byteCap = large ? caps.maxLargeBytes : longTtl ? longTtlCap(caps.maxStoredBytes) : caps.maxStoredBytes;
  try {
    stored = await store.insertIfBelowCap(id, blob, now + ttl * 1000, rowCap, byteCap);
  } catch (e) {
    if (!(e instanceof CounterMissingError)) throw e;
    console.error(e.name); // the name only: nothing about the request
    return error(500, "Internal error");
  }
  if (!stored && longTtl) {
    // Also answered while the store is completely full: the router cannot tell the cases apart without a second query.
    return json(
      409,
      { error: "The service is nearly full, so new links can last at most 1 day right now.", maxTtl: NEAR_FULL_MAX_TTL_SECONDS },
    );
  }
  if (!stored) return error(503, "The service is full right now, try again later", { "Retry-After": "300" });
  return json(201, { id });
}

/** The router: a plain function so tests can call it and the Pages Function can delegate to it. */
export async function handle(
  request: Request,
  store: SecretStore,
  ctx: WaitUntil,
  options: Options = {},
): Promise<Response> {
  const now = options.now ?? Date.now();
  const url = new URL(request.url);

  if (url.pathname === "/api/limits") {
    if (request.method !== "GET") return error(405, "Method not allowed", { Allow: "GET" });
    return json(200, {
      maxFileBytes: filesOn(options) ? (options.maxFileBytes ?? MAX_FILE_BYTES) : 0,
      maxFileTtl: options.maxFileTtl ?? LARGE_MAX_TTL_SECONDS,
      maxTextBytes: MAX_SECRET_BYTES,
    });
  }

  if (url.pathname === "/api/secrets") {
    if (request.method !== "POST") return error(405, "Method not allowed", { Allow: "POST" });
    return createSecret(request, store, url, now, {
      maxStored: options.maxStored ?? MAX_STORED_SECRETS,
      maxStoredBytes: options.maxStoredBytes ?? MAX_STORED_BYTES,
      maxLargeBytes: options.maxLargeBytes ?? MAX_LARGE_STORED_BYTES,
      maxFileTtl: options.maxFileTtl ?? LARGE_MAX_TTL_SECONDS,
      maxBlob: blobLimit(options),
    });
  }

  const match = /^\/api\/secrets\/([^/]+)(\/reveal)?$/.exec(url.pathname);
  if (!match) return error(404, "Not found");
  const id = match[1]!;
  const isReveal = match[2] !== undefined;
  if (!ID_PATTERN.test(id)) return error(404, "Not found");

  if (isReveal) {
    // POST only: link previews and prefetchers send GET and must not burn the secret.
    if (request.method !== "POST") return error(405, "Method not allowed", { Allow: "POST" });
    const blob = await store.take(id, now);
    ctx.waitUntil(store.purgeExpired(now));
    if (blob === null) return error(404, "This secret was already opened or has expired");
    return new Response(blob, {
      headers: { ...API_HEADERS, "Content-Type": "application/octet-stream" },
    });
  }

  if (request.method !== "GET") return error(405, "Method not allowed", { Allow: "GET" });
  const found = await store.exists(id, now);
  ctx.waitUntil(store.purgeExpired(now));
  return found ? json(200, { exists: true }) : error(404, "This secret was already opened or has expired");
}
