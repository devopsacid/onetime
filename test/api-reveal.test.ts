import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, BodyReadError, createSecret, revealSecret } from "../src/web/api";

afterEach(() => vi.unstubAllGlobals());

function streamOf(chunks: Uint8Array[], then?: "error"): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]!);
      else if (then === "error") controller.error(new TypeError("network"));
      else controller.close();
    },
  });
}

function stub(response: Response): void {
  vi.stubGlobal("fetch", async () => response);
}

describe("revealSecret", () => {
  it("reads the body in chunks, reports progress against Content-Length, and returns the bytes", async () => {
    stub(new Response(streamOf([new Uint8Array([1, 2]), new Uint8Array([3])]), { status: 200, headers: { "content-length": "3" } }));
    const seen: Array<[number, number | null]> = [];
    const out = await revealSecret("a".repeat(22), { maxBytes: 100, onProgress: (l, t) => seen.push([l, t]) });
    expect(Array.from(out)).toEqual([1, 2, 3]);
    expect(seen).toEqual([[2, 3], [3, 3]]);
  });

  it("works without options", async () => {
    stub(new Response(new Uint8Array([5])));
    expect(Array.from(await revealSecret("a".repeat(22)))).toEqual([5]);
  });

  it("stops at maxBytes by counting, ignoring a lying Content-Length", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(60));
      },
      cancel() {
        cancelled = true;
      },
    });
    stub(new Response(body, { headers: { "content-length": "10" } }));
    await expect(revealSecret("a".repeat(22), { maxBytes: 100 })).rejects.toBeInstanceOf(BodyReadError);
    expect(cancelled).toBe(true);
  });

  it("a Content-Length above maxBytes is refused without reading", async () => {
    stub(new Response(new Uint8Array(1), { headers: { "content-length": "101" } }));
    await expect(revealSecret("a".repeat(22), { maxBytes: 100 })).rejects.toBeInstanceOf(BodyReadError);
  });

  it("a stream error after the 200 is a BodyReadError (the row is already deleted)", async () => {
    stub(new Response(streamOf([new Uint8Array(2)], "error")));
    await expect(revealSecret("a".repeat(22), { maxBytes: 100 })).rejects.toBeInstanceOf(BodyReadError);
  });

  it("non-OK answers stay ApiErrors", async () => {
    stub(new Response(JSON.stringify({ error: "gone" }), { status: 404 }));
    const error = await revealSecret("a".repeat(22)).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(404);
  });

  it("passes the AbortSignal to fetch", async () => {
    let got: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => ((got = init.signal), new Response(new Uint8Array(1))));
    const controller = new AbortController();
    await revealSecret("a".repeat(22), { signal: controller.signal });
    expect(got).toBe(controller.signal);
  });
});

describe("createSecret signal", () => {
  it("passes the signal to fetch", async () => {
    let got: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => ((got = init.signal), new Response(JSON.stringify({ id: "x" }), { status: 201 })));
    const controller = new AbortController();
    expect(await createSecret(new Uint8Array(40), 3600, controller.signal)).toBe("x");
    expect(got).toBe(controller.signal);
  });
});
