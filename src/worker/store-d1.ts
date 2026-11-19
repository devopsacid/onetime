import type { SecretStore } from "./store";

/** D1 hands BLOB columns to JavaScript as an array of numbers. */
function toBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  throw new Error("Unexpected blob type");
}

export function d1Store(db: D1Database): SecretStore {
  return {
    async insertIfBelowCap(id, blob, expiresAt, now, maxStored) {
      // One statement checks the cap and inserts, so concurrent creates cannot overshoot it.
      const result = await db
        .prepare(
          "INSERT INTO secrets (id, blob, expires_at) SELECT ?1, ?2, ?3 WHERE (SELECT COUNT(*) FROM secrets WHERE expires_at > ?4) < ?5",
        )
        .bind(id, blob.buffer, expiresAt, now, maxStored)
        .run();
      return result.meta.changes !== 0;
    },
    async take(id, now) {
      // One statement reads and deletes, so only one caller can get the row.
      const row = await db
        .prepare("DELETE FROM secrets WHERE id = ? AND expires_at > ? RETURNING blob")
        .bind(id, now)
        .first<{ blob: unknown }>();
      return row === null ? null : toBytes(row.blob);
    },
    async exists(id, now) {
      const found = await db.prepare("SELECT 1 AS found FROM secrets WHERE id = ? AND expires_at > ?").bind(id, now).first();
      return found !== null;
    },
    async purgeExpired(now) {
      await db.prepare("DELETE FROM secrets WHERE expires_at <= ?").bind(now).run();
    },
  };
}
