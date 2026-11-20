import {
  BLOB_OVERHEAD_BYTES,
  ID_PATTERN,
  MAX_BLOB_BYTES,
  MAX_STORED_SECRETS,
  NEAR_FULL_MAX_TTL_SECONDS,
  longTtlCap,
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
} from "../shared/limits";
import { CounterMissingError, type SecretStore, type WaitUntil } from "./store";

/** Test hooks: a fixed clock (ms since epoch) and a smaller cap. The Node server also sets maxStored. */
export interface Options {
  now?: number;
  maxStored?: number;
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
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function createSecret(request: Request, store: SecretStore, url: URL, now: number, maxStored: number): Promise<Response> {
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
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_BLOB_BYTES) {
    return error(413, "Secret is too large");
  }

  const blob = await readBounded(request.body, MAX_BLOB_BYTES);
  if (blob === null) return error(413, "Secret is too large");
  if (blob.byteLength <= BLOB_OVERHEAD_BYTES) return error(400, "Invalid secret size");

  await store.purgeExpired(now);

  const id = newId();
  let stored: boolean;
  const longTtl = ttl > NEAR_FULL_MAX_TTL_SECONDS;
  try {
    stored = await store.insertIfBelowCap(id, blob, now + ttl * 1000, longTtl ? longTtlCap(maxStored) : maxStored);
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

  if (url.pathname === "/api/secrets") {
    if (request.method !== "POST") return error(405, "Method not allowed", { Allow: "POST" });
    return createSecret(request, store, url, now, options.maxStored ?? MAX_STORED_SECRETS);
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
