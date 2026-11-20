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

export async function createSecret(blob: Uint8Array<ArrayBuffer>, ttlSeconds: number): Promise<string> {
  const response = await fetch(`/api/secrets?ttl=${ttlSeconds}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: blob,
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

/** Fetches the encrypted blob; the server deletes it in the same step. */
export async function revealSecret(id: string): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(`/api/secrets/${id}/reveal`, { method: "POST" });
  if (!response.ok) return fail(response);
  return new Uint8Array(await response.arrayBuffer());
}
