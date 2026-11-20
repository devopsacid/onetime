import { afterEach, describe, expect, it, vi } from "vitest";
import { HOSTED_LIMITS, parseLimits } from "../src/shared/limits";
import { fetchLimits } from "../src/web/api";

afterEach(() => vi.unstubAllGlobals());

const stub = (response: Response | (() => Promise<Response>)): { urls: string[] } => {
  const seen = { urls: [] as string[] };
  vi.stubGlobal("fetch", async (url: string) => {
    seen.urls.push(url);
    return typeof response === "function" ? response() : response;
  });
  return seen;
};
const ok = { maxFileBytes: 262_144, maxFileTtl: 3600, maxTextBytes: 16_384 };

describe("HOSTED_LIMITS", () => {
  it("are the built-in hosted values clients assume when a server has no /api/limits", () => {
    expect(HOSTED_LIMITS).toEqual(ok);
  });
});

describe("parseLimits", () => {
  it("accepts the three fields and ignores extra ones", () => {
    expect(parseLimits(ok)).toEqual(ok);
    expect(parseLimits({ ...ok, extra: 1 })).toEqual(ok);
    expect(parseLimits({ maxFileBytes: 0, maxFileTtl: 60, maxTextBytes: 1 })).toEqual({ maxFileBytes: 0, maxFileTtl: 60, maxTextBytes: 1 });
    expect(parseLimits({ maxFileBytes: 5_242_880, maxFileTtl: 604_800, maxTextBytes: 16_384 })).not.toBeNull();
  });
  it.each([
    ["null", null],
    ["an array", [1, 2, 3]],
    ["a string", "x"],
    ["missing maxFileBytes", { maxFileTtl: 3600, maxTextBytes: 16_384 }],
    ["missing maxFileTtl", { maxFileBytes: 1, maxTextBytes: 16_384 }],
    ["missing maxTextBytes", { maxFileBytes: 1, maxFileTtl: 3600 }],
    ["a string number", { ...ok, maxFileBytes: "262144" }],
    ["a fraction", { ...ok, maxFileBytes: 1.5 }],
    ["a negative size", { ...ok, maxFileBytes: -1 }],
    ["a size above the 5 MiB format maximum", { ...ok, maxFileBytes: 5_242_881 }],
    ["NaN", { ...ok, maxFileBytes: Number.NaN }],
    ["a TTL below 60", { ...ok, maxFileTtl: 59 }],
    ["a TTL above 7 days", { ...ok, maxFileTtl: 604_801 }],
    ["a text limit of 0", { ...ok, maxTextBytes: 0 }],
    ["a text limit above 16 KiB", { ...ok, maxTextBytes: 16_385 }],
  ])("rejects %s", (_name, value) => {
    expect(parseLimits(value)).toBeNull();
  });
});

describe("fetchLimits", () => {
  it("GETs /api/limits and returns the validated limits", async () => {
    const seen = stub(Response.json({ ...ok, maxFileBytes: 1_048_576, maxFileTtl: 86_400 }));
    expect(await fetchLimits()).toEqual({ maxFileBytes: 1_048_576, maxFileTtl: 86_400, maxTextBytes: 16_384 });
    expect(seen.urls).toEqual(["/api/limits"]);
  });
  it("returns null for an older server (404, 405), a server error and a network failure, so the caller uses HOSTED_LIMITS", async () => {
    for (const status of [404, 405, 500, 503]) {
      stub(new Response("{}", { status }));
      expect(await fetchLimits()).toBeNull();
    }
    stub(async () => Promise.reject(new TypeError("network")));
    expect(await fetchLimits()).toBeNull();
  });
  it("returns null for HTML, invalid JSON and invalid values", async () => {
    stub(new Response("<!doctype html><title>app</title>", { status: 200, headers: { "content-type": "text/html" } }));
    expect(await fetchLimits()).toBeNull();
    stub(new Response("{not json", { status: 200 }));
    expect(await fetchLimits()).toBeNull();
    stub(Response.json({ ...ok, maxFileBytes: 99_999_999 }));
    expect(await fetchLimits()).toBeNull();
  });
  it("stops reading at 1 KiB: a larger reply is refused and the stream cancelled", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(600).fill(32));
      },
      cancel() {
        cancelled = true;
      },
    });
    stub(new Response(body, { status: 200 }));
    expect(await fetchLimits()).toBeNull();
    expect(cancelled).toBe(true);
  });
  it("passes the abort signal on", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return Response.json(ok);
    });
    expect(await fetchLimits(controller.signal)).toBeNull();
  });
});
