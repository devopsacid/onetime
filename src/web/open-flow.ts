import { ApiError } from "./api";
import type { AesKey, LinkKey } from "./crypto";
import { validatePassphrase, type PassphraseProblem } from "./passphrase";

export type OpenPhase = "preparing" | "revealing" | "revealed";

export interface OpenDeps {
  deriveKey(link: LinkKey, passphrase?: string): Promise<AesKey>;
  revealSecret(id: string): Promise<Uint8Array<ArrayBuffer>>;
  openBlob(blob: Uint8Array<ArrayBuffer>, aesKey: AesKey, link: LinkKey): Promise<string>;
}

export type OpenOutcome =
  /** A file link, and this build has no file UI: nothing was derived or requested. Removed when the file UI lands. */
  | { kind: "unsupported" }
  | { kind: "revealed"; text: string }
  /** The entry cannot be right, so nothing was derived and no request was sent. */
  | { kind: "invalid"; problem: PassphraseProblem }
  /** The server says it is gone (404). */
  | { kind: "gone" }
  /** The secret was handed over (and deleted) but did not decrypt. */
  | { kind: "undecryptable"; passphrase: boolean }
  /** Key preparation failed before any request: nothing is used up. */
  | { kind: "prepare-failed" }
  /** The reveal request failed for another reason: the caller keeps the entry for a retry. */
  | { kind: "network"; error: unknown };

/**
 * The slow key step runs before the reveal request, so a slow device never burns the secret while
 * still hashing, and an entry that fails validation never reaches the network.
 * `onPhase("revealed")` fires as soon as the secret is handed over: the caller drops the key from the address bar.
 */
export async function openSecret(
  link: LinkKey & { id: string },
  entry: string,
  deps: OpenDeps,
  onPhase: (phase: OpenPhase) => void = () => {},
): Promise<OpenOutcome> {
  if (link.file) return { kind: "unsupported" };
  const passphrase = link.passphrase ? entry : undefined;
  if (passphrase !== undefined) {
    const problem = validatePassphrase(passphrase);
    if (problem !== null) return { kind: "invalid", problem };
  }
  onPhase("preparing");
  let aesKey: AesKey;
  try {
    aesKey = await deps.deriveKey(link, passphrase);
  } catch {
    return { kind: "prepare-failed" };
  }
  onPhase("revealing");
  let blob: Uint8Array<ArrayBuffer>;
  try {
    blob = await deps.revealSecret(link.id);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { kind: "gone" };
    return { kind: "network", error };
  }
  onPhase("revealed");
  try {
    return { kind: "revealed", text: await deps.openBlob(blob, aesKey, link) };
  } catch {
    return { kind: "undecryptable", passphrase: link.passphrase };
  }
}

/**
 * Like openSecret, for a page that can be re-routed (hashchange) while the request is out. `ticket` is the guard's current
 * ticket at submit time. If a newer route has started, the phases are no longer signalled (so the caller never rewrites the
 * address bar of the new route) and the outcome is reported as stale: the caller must ignore it.
 */
export async function openSecretGuarded(
  guard: { isCurrent(ticket: number): boolean },
  ticket: number,
  link: LinkKey & { id: string },
  entry: string,
  deps: OpenDeps,
  onPhase: (phase: OpenPhase) => void = () => {},
): Promise<{ stale: true } | { stale: false; outcome: OpenOutcome }> {
  const outcome = await openSecret(link, entry, deps, (phase) => {
    if (guard.isCurrent(ticket)) onPhase(phase);
  });
  return guard.isCurrent(ticket) ? { stale: false, outcome } : { stale: true };
}
