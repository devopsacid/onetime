import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { onRequest } from "../functions/api/[[path]]";
import { handle, type Options } from "../src/worker/index";
import { d1Store } from "../src/worker/store-d1";
import { defineApiContract } from "./contract/api-contract";

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

describe("API contract on D1", () => {
  defineApiContract({
    async call(path: string, init: RequestInit = {}, options?: Options): Promise<Response> {
      const ctx = createExecutionContext();
      const response = await handle(new Request(`${BASE}${path}`, init), d1Store(env.DB), ctx, options);
      await waitOnExecutionContext(ctx);
      return response;
    },
    rowCount: async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM secrets").first<{ n: number }>())!.n,
    expiresAt: async (id) =>
      (await env.DB.prepare("SELECT expires_at FROM secrets WHERE id = ?").bind(id).first<{ expires_at: number }>())?.expires_at ?? null,
    setExpiresAt: async (id, ms) => {
      await env.DB.prepare("UPDATE secrets SET expires_at = ? WHERE id = ?").bind(ms, id).run();
    },
    ids: async () => (await env.DB.prepare("SELECT id FROM secrets").all<{ id: string }>()).results.map((r) => r.id),
  });
});
