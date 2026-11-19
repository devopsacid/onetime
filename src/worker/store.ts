export interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

/** All methods take `now` (ms since epoch) so tests control the clock. A row is live while expires_at > now. */
export interface SecretStore {
  /** One atomic step: insert only if fewer than `maxStored` live rows exist. False = full. Must never overshoot under concurrency. */
  insertIfBelowCap(id: string, blob: Uint8Array<ArrayBuffer>, expiresAt: number, now: number, maxStored: number): Promise<boolean>;
  /** One atomic step: delete the live row and return its blob; null if missing or expired. Exactly one concurrent caller wins. */
  take(id: string, now: number): Promise<Uint8Array<ArrayBuffer> | null>;
  /** True if a live row exists. Never deletes or modifies it. */
  exists(id: string, now: number): Promise<boolean>;
  /** Delete rows with expires_at <= now. Frees space only; reads already enforce expiry. */
  purgeExpired(now: number): Promise<void>;
}
