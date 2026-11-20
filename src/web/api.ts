import { MAX_TTL_SECONDS, MIN_TTL_SECONDS } from "../shared/limits";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Set when the server says links may last at most this many seconds (409 while nearly full). */
    readonly maxTtl?: number,
  ) {
    super(message);
  }
}

async function fail(response: Response): Promise<never> {
  let message = `Request failed (${response.status})`;
  let maxTtl: number | undefined;
  try {
    const body = (await response.json()) as { error?: unknown; maxTtl?: unknown };
    if (typeof body.error === "string") message = body.error;
    if (typeof body.maxTtl === "number" && Number.isSafeInteger(body.maxTtl) && body.maxTtl >= MIN_TTL_SECONDS && body.maxTtl <= MAX_TTL_SECONDS) {
      maxTtl = body.maxTtl;
    }
  } catch {
    // Not JSON: keep the generic message.
  }
  throw new ApiError(response.status, message, maxTtl);
}

export async function createSecret(blob: Uint8Array<ArrayBuffer>, ttlSeconds: number, signal?: AbortSignal): Promise<string> {
  const response = await fetch(`/api/secrets?ttl=${ttlSeconds}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: blob,
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) return fail(response);
  return ((await response.json()) as { id: string }).id;
}

export async function secretExists(id: string): Promise<boolean> {
  const response = await fetch(`/api/secrets/${id}`);
  if (response.status === 404) return false;
  if (!response.ok) return fail(response);
  return true;
}

/** The reveal was answered 200 (so the row is deleted) but the body did not arrive intact or within the cap. */
export class BodyReadError extends Error {}

export interface RevealOptions {
  signal?: AbortSignal;
  /** Counted while reading; Content-Length is only used for progress and an early refusal, never trusted. */
  maxBytes?: number;
  onProgress?: (loaded: number, total: number | null) => void;
}

/** Fetches the encrypted blob; the server deletes it in the same step. */
export async function revealSecret(id: string, options: RevealOptions = {}): Promise<Uint8Array<ArrayBuffer>> {
  const { signal, maxBytes = Infinity, onProgress } = options;
  const response = await fetch(`/api/secrets/${id}/reveal`, { method: "POST", ...(signal ? { signal } : {}) });
  if (!response.ok) return fail(response);
  const header = Number(response.headers.get("content-length"));
  const total = Number.isSafeInteger(header) && header > 0 ? header : null;
  if (total !== null && total > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw new BodyReadError("The reply is larger than allowed");
  }
  if (!response.body) throw new BodyReadError("The reply has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      loaded += value.byteLength;
      if (loaded > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new BodyReadError("The reply is larger than allowed");
      }
      chunks.push(value);
      onProgress?.(loaded, total);
    }
  } catch (error) {
    if (error instanceof BodyReadError) throw error;
    throw new BodyReadError("The reply was cut off");
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
    chunk.fill(0);
  }
  return out;
}
