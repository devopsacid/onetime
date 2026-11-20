import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { boundedBody } from "../../server/http";
import { MAX_BLOB_BYTES } from "../../src/shared/limits";

/** An endless upstream that counts how many bytes it was asked to produce. */
function endless(chunkSize: number): { req: IncomingMessage; produced(): number } {
  let produced = 0;
  const req = new Readable({
    highWaterMark: chunkSize,
    read() {
      produced += chunkSize;
      this.push(Buffer.alloc(chunkSize, 7));
    },
  });
  return { req: req as unknown as IncomingMessage, produced: () => produced };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return total;
    total += value.length;
  }
}

describe("boundedBody", () => {
  it("lets exactly 16,418 bytes through complete and cuts at 16,419", async () => {
    expect(MAX_BLOB_BYTES).toBe(16_418);
    const exact = Readable.from([Buffer.alloc(16_418, 1)]) as unknown as IncomingMessage;
    const ok = boundedBody(exact);
    expect(await readAll(ok.stream)).toBe(16_418);
    expect(ok.complete()).toBe(true);
    const over = Readable.from([Buffer.alloc(16_419, 1)]) as unknown as IncomingMessage;
    const cut = boundedBody(over);
    expect(await readAll(cut.stream)).toBe(16_419);
    expect(cut.complete()).toBe(false);
  });

  it("ends at MAX_BLOB_BYTES + 1 bytes and stops pulling from an endless upstream", async () => {
    const { req, produced } = endless(64 * 1024);
    const body = boundedBody(req);
    expect(await readAll(body.stream)).toBe(MAX_BLOB_BYTES + 1);
    expect(body.complete()).toBe(false);
    const atEnd = produced();
    await new Promise((r) => setTimeout(r, 100));
    expect(produced()).toBe(atEnd);
    // Bounded: not more than a few chunks beyond the limit were ever pulled.
    expect(atEnd).toBeLessThan(MAX_BLOB_BYTES + 1 + 8 * 64 * 1024);
    expect(req.destroyed).toBe(false);
    expect(req.isPaused()).toBe(true);
    expect(req.listenerCount("data")).toBe(0);
    req.destroy();
  });

  it("cuts a chunk that straddles the limit and keeps the stream open for the router's answer", async () => {
    const { req } = endless(MAX_BLOB_BYTES); // first chunk is exactly the limit, the second straddles it
    const body = boundedBody(req);
    expect(await readAll(body.stream)).toBe(MAX_BLOB_BYTES + 1);
    req.destroy();
  });

  it("passes a short body through unchanged and reports it complete", async () => {
    const req = Readable.from([Buffer.from("abc"), Buffer.from("def")]) as unknown as IncomingMessage;
    const body = boundedBody(req);
    expect(await readAll(body.stream)).toBe(6);
    expect(body.complete()).toBe(true);
  });
});
