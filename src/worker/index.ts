import {
  BLOB_OVERHEAD_BYTES,
  ID_PATTERN,
  MAX_BLOB_BYTES,
  MAX_STORED_SECRETS,
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
} from "../shared/limits";

export type Env = Cloudflare.Env;

/** Test hooks: a fixed clock (ms since epoch) and a smaller cap. */
export interface Options {
  now?: number;
  maxStored?: number;
}

const API_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex",
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

/** Deletes expired rows. Expiry is enforced on read too, so this only frees space. */
function purge(env: Env, now: number): Promise<unknown> {
  return env.DB.prepare("DELETE FROM secrets WHERE expires_at <= ?").bind(now).run();
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

async function createSecret(request: Request, env: Env, url: URL, now: number, maxStored: number): Promise<Response> {
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

  await purge(env, now);

  // One statement checks the cap and inserts, so concurrent creates cannot overshoot it.
  const id = newId();
  const result = await env.DB.prepare(
    "INSERT INTO secrets (id, blob, expires_at) SELECT ?1, ?2, ?3 WHERE (SELECT COUNT(*) FROM secrets WHERE expires_at > ?4) < ?5",
  )
    .bind(id, blob.buffer, now + ttl * 1000, now, maxStored)
    .run();
  if (result.meta.changes === 0) return error(503, "The service is full right now, try again later", { "Retry-After": "300" });
  return json(201, { id });
}

/** D1 hands BLOB columns to JavaScript as an array of numbers. */
function toBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  throw new Error("Unexpected blob type");
}

/** The router: a plain function so tests can call it and the Pages Function can delegate to it. */
export async function handle(
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  options: Options = {},
): Promise<Response> {
  const now = options.now ?? Date.now();
  const url = new URL(request.url);

  if (url.pathname === "/api/secrets") {
    if (request.method !== "POST") return error(405, "Method not allowed", { Allow: "POST" });
    return createSecret(request, env, url, now, options.maxStored ?? MAX_STORED_SECRETS);
  }

  const match = /^\/api\/secrets\/([^/]+)(\/reveal)?$/.exec(url.pathname);
  if (!match) return error(404, "Not found");
  const id = match[1]!;
  const isReveal = match[2] !== undefined;
  if (!ID_PATTERN.test(id)) return error(404, "Not found");

  if (isReveal) {
    // POST only: link previews and prefetchers send GET and must not burn the secret.
    if (request.method !== "POST") return error(405, "Method not allowed", { Allow: "POST" });
    // One statement reads and deletes, so only one caller can get the row.
    const row = await env.DB.prepare("DELETE FROM secrets WHERE id = ? AND expires_at > ? RETURNING blob")
      .bind(id, now)
      .first<{ blob: unknown }>();
    ctx.waitUntil(purge(env, now));
    if (row === null) return error(404, "This secret was already opened or has expired");
    return new Response(toBytes(row.blob), {
      headers: { ...API_HEADERS, "Content-Type": "application/octet-stream" },
    });
  }

  if (request.method !== "GET") return error(405, "Method not allowed", { Allow: "GET" });
  const found = await env.DB.prepare("SELECT 1 AS found FROM secrets WHERE id = ? AND expires_at > ?").bind(id, now).first();
  ctx.waitUntil(purge(env, now));
  return found !== null ? json(200, { exists: true }) : error(404, "This secret was already opened or has expired");
}
