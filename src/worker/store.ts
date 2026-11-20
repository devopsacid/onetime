export interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

/** Methods that read or expire rows take `now` (ms since epoch) so tests control the clock. A row is live while expires_at > now. */
/** The `stats` counter row (migration 0002) is missing, so the cap cannot be checked. Creates fail closed with this. */
export class CounterMissingError extends Error {
  constructor() {
    super("The stats counter row is missing. Repair: INSERT INTO stats (id, stored) SELECT 1, COUNT(*) FROM secrets");
    this.name = "CounterMissingError";
  }
}

export interface SecretStore {
  /** One atomic step: insert only if fewer than `maxStored` rows are stored. False = full. Throws CounterMissingError if the counter row is missing (never fails open, never reports that as full). Counts stored rows, expired ones not yet purged included (the router purges first), from the `stats` counter row that triggers keep exact. Must never overshoot under concurrency. */
  insertIfBelowCap(id: string, blob: Uint8Array<ArrayBuffer>, expiresAt: number, maxStored: number): Promise<boolean>;
  /** One atomic step: delete the live row and return its blob; null if missing or expired. Exactly one concurrent caller wins. */
  take(id: string, now: number): Promise<Uint8Array<ArrayBuffer> | null>;
  /** True if a live row exists. Never deletes or modifies it. */
  exists(id: string, now: number): Promise<boolean>;
  /** Delete rows with expires_at <= now. Frees space only; reads already enforce expiry. */
  purgeExpired(now: number): Promise<void>;
}
