export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function fail(response: Response): Promise<never> {
  let message = `Request failed (${response.status})`;
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") message = body.error;
  } catch {
    // Not JSON: keep the generic message.
  }
  throw new ApiError(response.status, message);
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
