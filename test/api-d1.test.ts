import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { onRequest } from "../functions/api/[[path]]";
import { handle, type Options } from "../src/worker/index";
import { d1Store } from "../src/worker/store-d1";
import { defineApiContract, expectAtomicSql, type IssuedSql } from "./contract/api-contract";

const BASE = "https://onetime.test";

describe("Pages Function entry", () => {
  it("serves the router through onRequest", async () => {
    const context = {
      request: new Request(`${BASE}/api/secrets`),
      env,
      waitUntil: () => {},
    } as unknown as Parameters<typeof onRequest>[0];
    expect((await onRequest(context)).status).toBe(405);
  });
});

describe("D1 store statements", () => {
  it("issues exactly one DELETE ... RETURNING for a reveal and one capped INSERT, and no SELECT-then-DELETE", async () => {
    let into: string[] = [];
    const spy = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") return (sql: string) => (into.push(sql), target.prepare(sql));
        if (prop === "exec" || prop === "batch") throw new Error(`unexpected ${String(prop)}`);
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const store = d1Store(spy);
    const id = "b".repeat(22);
    const now = 1_800_000_000_000;
    await store.insertIfBelowCap(id, new Uint8Array(40), now + 60_000, 10);
    const issued: IssuedSql = { reveal: [], insert: into };
    into = [];
    expect(await store.take(id, now)).not.toBeNull();
    issued.reveal = into;
    expectAtomicSql(issued);
  });
});

describe("API contract on D1", () => {
  defineApiContract({
    async call(path: string, init: RequestInit = {}, options?: Options): Promise<Response> {
      const ctx = createExecutionContext();
      const response = await handle(new Request(`${BASE}${path}`, init), d1Store(env.DB), ctx, options);
      await waitOnExecutionContext(ctx);
      return response;
    },
    rowCount: async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM secrets").first<{ n: number }>())!.n,
    storedCounter: async () => (await env.DB.prepare("SELECT stored FROM stats WHERE id = 1").first<{ stored: number }>())!.stored,
    removeCounter: async () => void (await env.DB.prepare("DELETE FROM stats WHERE id = 1").run()),
    restoreCounter: async () =>
      void (await env.DB.prepare("INSERT OR REPLACE INTO stats (id, stored) SELECT 1, COUNT(*) FROM secrets").run()),
    expiresAt: async (id) =>
      (await env.DB.prepare("SELECT expires_at FROM secrets WHERE id = ?").bind(id).first<{ expires_at: number }>())?.expires_at ?? null,
    setExpiresAt: async (id, ms) => {
      await env.DB.prepare("UPDATE secrets SET expires_at = ? WHERE id = ?").bind(ms, id).run();
    },
    ids: async () => (await env.DB.prepare("SELECT id FROM secrets").all<{ id: string }>()).results.map((r) => r.id),
  });
});
