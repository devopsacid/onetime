import { describe, expect, it } from "vitest";
import { handle } from "../src/worker";
import { d1Store } from "../src/worker/store-d1";
import type { SecretStore } from "../src/worker/store";

const ctx = { waitUntil: () => {} };

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i < chunks.length) c.enqueue(chunks[i++]!);
      else c.close();
    },
  });
}

function capturingStore(): { store: SecretStore; blobs: Array<Uint8Array<ArrayBuffer>> } {
  const blobs: Array<Uint8Array<ArrayBuffer>> = [];
  return {
    blobs,
    store: {
      insertIfBelowCap: async (_id, blob) => {
        blobs.push(blob);
        return true;
      },
      take: async () => null,
      exists: async () => false,
      purgeExpired: async () => {},
    },
  };
}

async function post(store: SecretStore, chunks: Uint8Array[]): Promise<Response> {
  const request = new Request("https://x.example/api/secrets?ttl=3600", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: streamOf(chunks),
    // @ts-expect-error duplex is required for stream bodies
    duplex: "half",
  });
  return handle(request, store, ctx);
}

const bytes = (n: number, start = 0) => Uint8Array.from({ length: n }, (_, i) => (start + i) & 255);

describe("readBounded (create path)", () => {
  it("a single-chunk body is stored as that very chunk, without a join copy", async () => {
    const { store, blobs } = capturingStore();
    const chunk = bytes(100);
    expect((await post(store, [chunk])).status).toBe(201);
    expect(blobs[0]!.buffer).toBe(chunk.buffer);
    expect(Array.from(blobs[0]!)).toEqual(Array.from(bytes(100)));
  });
  it("a single chunk that is a view into a bigger buffer is copied exactly (the store binds .buffer)", async () => {
    const { store, blobs } = capturingStore();
    const big = bytes(200);
    expect((await post(store, [big.subarray(50, 150)])).status).toBe(201);
    expect(blobs[0]!.buffer.byteLength).toBe(100);
    expect(Array.from(blobs[0]!)).toEqual(Array.from(bytes(100, 50)));
  });
  it("a multi-chunk body is joined in order", async () => {
    const { store, blobs } = capturingStore();
    expect((await post(store, [bytes(40), bytes(40, 40), bytes(20, 80)])).status).toBe(201);
    expect(Array.from(blobs[0]!)).toEqual(Array.from(bytes(100)));
  });
});

describe("d1Store.take blob conversion", () => {
  const dbReturning = (blob: unknown) =>
    ({ prepare: () => ({ bind: () => ({ first: async () => ({ blob }) }) }) }) as unknown as D1Database;

  it("converts the array of numbers D1 returns", async () => {
    const out = await d1Store(dbReturning([0, 1, 255, 128])).take("a".repeat(22), 0);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out!)).toEqual([0, 1, 255, 128]);
  });
  it("copies an ArrayBuffer", async () => {
    const source = Uint8Array.from([9, 8, 7]).buffer;
    const out = await d1Store(dbReturning(source)).take("a".repeat(22), 0);
    expect(Array.from(out!)).toEqual([9, 8, 7]);
    expect(out!.buffer).not.toBe(source);
  });
  it("converts a large array", async () => {
    const big = Array.from({ length: 262_144 }, (_, i) => i & 255);
    const out = await d1Store(dbReturning(big)).take("a".repeat(22), 0);
    expect(out!.byteLength).toBe(262_144);
    expect(out![255]).toBe(255);
    expect(out![256]).toBe(0);
  });
  it("rejects anything else", async () => {
    await expect(d1Store(dbReturning("text")).take("a".repeat(22), 0)).rejects.toThrow();
  });
});
