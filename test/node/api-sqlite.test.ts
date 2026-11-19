import { afterEach, beforeEach, describe } from "vitest";
import { handle, type Options } from "../../src/worker/index";
import { openSqliteStore, type SqliteStore } from "../../server/store-sqlite";
import { defineApiContract } from "../contract/api-contract";
import { migrations, tempDir } from "./helpers";

const BASE = "https://onetime.test";

describe("API contract on SQLite", () => {
  let dir: ReturnType<typeof tempDir>;
  let store: SqliteStore;

  // A fresh database per test: the contract relies on an empty table.
  beforeEach(() => {
    dir = tempDir();
    store = openSqliteStore(`${dir.path}/onetime.db`, migrations());
  });
  afterEach(async () => {
    await store.close();
    dir.remove();
  });

  defineApiContract({
    async call(path: string, init: RequestInit = {}, options?: Options): Promise<Response> {
      const pending: Promise<unknown>[] = [];
      const response = await handle(new Request(`${BASE}${path}`, init), store, { waitUntil: (p) => void pending.push(p) }, options);
      await Promise.all(pending);
      return response;
    },
    rowCount: async () => (store.db.prepare("SELECT COUNT(*) AS n FROM secrets").get() as { n: number }).n,
    expiresAt: async (id) => (store.db.prepare("SELECT expires_at FROM secrets WHERE id = ?").get(id) as { expires_at: number } | undefined)?.expires_at ?? null,
    setExpiresAt: async (id, ms) => {
      store.db.prepare("UPDATE secrets SET expires_at = ? WHERE id = ?").run(ms, id);
    },
    ids: async () => (store.db.prepare("SELECT id FROM secrets").all() as { id: string }[]).map((r) => r.id),
  });
});
