import { CounterMissingError, type SecretStore } from "./store";

/** D1 hands BLOB columns to JavaScript as an array of numbers. */
function toBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (Array.isArray(value)) return new Uint8Array(value as number[]);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  throw new Error("Unexpected blob type");
}

export function d1Store(db: D1Database): SecretStore {
  return {
    async insertIfBelowCap(id, blob, expiresAt, maxStored, maxBytes) {
      // One statement checks both caps (the counter row that the triggers of migration 0003 maintain) and inserts, so concurrent creates cannot overshoot them.
      const result = await db
        .prepare(
          "INSERT INTO secrets (id, blob, expires_at) SELECT ?1, ?2, ?3 WHERE (SELECT stored < ?4 AND bytes + length(?2) <= ?5 FROM stats WHERE id = 1)",
        )
        .bind(id, blob.buffer, expiresAt, maxStored, maxBytes)
        .run();
      if (result.meta.changes !== 0) return true;
      // Refused: full, or the counter row is missing (the subquery is then NULL). One cheap read tells them apart.
      if ((await db.prepare("SELECT 1 AS found FROM stats WHERE id = 1").first()) === null) throw new CounterMissingError();
      return false;
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
