import type { ClientKind } from "../shared/usage";
import { MAX_TTL_SECONDS, MIN_TTL_SECONDS, parseLimits, type ServerLimits } from "../shared/limits";

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

/** `kind` only feeds the aggregate usage counters (docs/plans/usage-counters.md); it comes from the link format, never from content. */
export async function createSecret(blob: Uint8Array<ArrayBuffer>, ttlSeconds: number, kind: ClientKind, signal?: AbortSignal): Promise<string> {
  const response = await fetch(`/api/secrets?ttl=${ttlSeconds}&kind=${kind}`, {
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
  /** Link kind for the usage counters; left out, the server counts `unknown`. */
  kind?: ClientKind;
  signal?: AbortSignal;
  /** Counted while reading; Content-Length is only used for progress and an early refusal, never trusted. */
  maxBytes?: number;
  onProgress?: (loaded: number, total: number | null) => void;
}

/** Fetches the encrypted blob; the server deletes it in the same step. */
export async function revealSecret(id: string, options: RevealOptions = {}): Promise<Uint8Array<ArrayBuffer>> {
  const { signal, maxBytes = Infinity, onProgress, kind } = options;
  const response = await fetch(`/api/secrets/${id}/reveal${kind ? `?kind=${kind}` : ""}`, { method: "POST", ...(signal ? { signal } : {}) });
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

/**
 * The page-load beacon of the app build: the same request as /api/limits, counted once by the server (a fixed string, never
 * built from location or the fragment). Only main.ts uses it, and only when `__SITE__ === "app"`, so the other builds
 * drop it and check-dist can prove that.
 */
export const LIMITS_VIEW_URL = "/api/limits?view=app";

/** The reply of GET /api/limits is a few dozen bytes; anything above this is not one. */
const LIMITS_MAX_BYTES = 1024;

/**
 * Asks the server for its file and text limits. Returns null for anything that is not a valid answer (an older server
 * without the endpoint, an error, HTML, a reply above 1 KiB, a network failure), so the caller falls back to HOSTED_LIMITS.
 */
export async function fetchLimits(options: { url?: string; signal?: AbortSignal } = {}): Promise<ServerLimits | null> {
  const { url = "/api/limits", signal } = options;
  try {
    const response = await fetch(url, signal ? { signal } : {});
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > LIMITS_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.byteLength;
    }
    return parseLimits(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}
