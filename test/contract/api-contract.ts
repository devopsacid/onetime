import { describe, expect, it } from "vitest";
import {
  ID_PATTERN,
  LARGE_MAX_TTL_SECONDS,
  MAX_BLOB_BYTES,
  MAX_LARGE_STORED_BYTES,
  MAX_STORED_BYTES,
  MAX_STORED_SECRETS,
  MAX_TEXT_BLOB_BYTES,
  MAX_TTL_SECONDS,
  NEAR_FULL_MAX_TTL_SECONDS,
  longTtlCap,
} from "../../src/shared/limits";
import type { Options } from "../../src/worker/index";
import type { Usage } from "../../src/worker/usage";

type BodyInit = NonNullable<RequestInit["body"]>;

/** What the contract suite needs from a runtime: the router wired to a fresh store, plus direct access to the rows. */
export interface ApiHarness {
  /** Runs the router, then waits for background work (purges) to finish. */
  call(path: string, init?: RequestInit, options?: Options): Promise<Response>;
  rowCount(): Promise<number>;
  /** The counter row, `SELECT stored FROM stats WHERE id = 1`. */
  storedCounter(): Promise<number>;
  /** The byte counter, `SELECT bytes FROM stats WHERE id = 1`. */
  storedBytes(): Promise<number>;
  /** `SELECT COALESCE(SUM(length(blob)), 0) FROM secrets`. */
  sumBlobBytes(): Promise<number>;
  /** Test only: deletes the counter row (a damaged database). `restoreCounter` puts it back, seeded from COUNT(*). */
  removeCounter(): Promise<void>;
  restoreCounter(): Promise<void>;
  expiresAt(id: string): Promise<number | null>;
  setExpiresAt(id: string, ms: number): Promise<void>;
  ids(): Promise<string[]>;
}

/** The API contract, runtime-neutral: the same cases run against D1 (workerd) and SQLite (Node). */
export function defineApiContract(h: ApiHarness): void {
  const call = h.call.bind(h);
  const rowCount = () => h.rowCount();

  function create(
    body: BodyInit,
    { ttl = "3600", headers = {} as Record<string, string>, options }: { ttl?: string; headers?: Record<string, string>; options?: Options } = {},
  ): Promise<Response> {
    return call(
      `/api/secrets?ttl=${ttl}`,
      { method: "POST", headers: { "Content-Type": "application/octet-stream", ...headers }, body },
      options,
    );
  }

  function blobOf(size: number): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i += 65_536) crypto.getRandomValues(out.subarray(i, Math.min(i + 65_536, size)));
    return out;
  }

  async function createOk(blob = blobOf(64), ttl = "3600", options?: Options): Promise<string> {
    const response = await create(blob, { ttl, options });
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    expect(id).toMatch(ID_PATTERN);
    return id;
  }

  const reveal = (id: string, options?: Options) => call(`/api/secrets/${id}/reveal`, { method: "POST" }, options);
  const status = (id: string, options?: Options) => call(`/api/secrets/${id}`, {}, options);

  describe("create and reveal", () => {
    it("returns the exact blob once, then 404", async () => {
      const blob = blobOf(200);
      const id = await createOk(blob);

      expect((await status(id)).status).toBe(200);

      const first = await reveal(id);
      expect(first.status).toBe(200);
      expect(first.headers.get("Cache-Control")).toBe("no-store");
      expect(first.headers.get("X-Robots-Tag")).toBe("noindex");
      expect(new Uint8Array(await first.arrayBuffer())).toEqual(blob);

      expect((await reveal(id)).status).toBe(404);
      expect((await status(id)).status).toBe(404);
    });

    it("lets only one of many simultaneous reveals win", async () => {
      const id = await createOk();
      const responses = await Promise.all(Array.from({ length: 10 }, () => reveal(id)));
      const codes = responses.map((response) => response.status).sort();
      await Promise.all(responses.map((response) => response.arrayBuffer()));
      expect(codes).toEqual([200, ...Array<number>(9).fill(404)]);
    });

    it("leaves nothing in the table after a reveal", async () => {
      const id = await createOk();
      await (await reveal(id)).arrayBuffer();
      expect(await h.ids()).not.toContain(id);
    });

    it("returns every byte value unchanged, including 0x00 and 0x80 and up", async () => {
      const blob = new Uint8Array(256 + 64);
      for (let i = 0; i < blob.length; i++) blob[i] = i % 256;
      const id = await createOk(blob);
      const response = await reveal(id);
      expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(blob);
    });

    it("does not burn the secret on GET, as a link preview would send", async () => {
      const id = await createOk();
      const response = await call(`/api/secrets/${id}/reveal`);
      expect(response.status).toBe(405);
      expect((await status(id)).status).toBe(200);
      expect((await reveal(id)).status).toBe(200);
    });

    it("gives different ids to identical blobs", async () => {
      const blob = blobOf(64);
      expect(await createOk(blob)).not.toBe(await createOk(blob));
    });
  });

  describe("expiry", () => {
    const T0 = 1_800_000_000_000;

    it("stores the expiry from the ttl", async () => {
      const id = await createOk(blobOf(64), "120", { now: T0 });
      expect(await h.expiresAt(id)).toBe(T0 + 120_000);
    });

    it("refuses an expired secret that was never opened, and a purge removes it", async () => {
      const id = await createOk(blobOf(64), "120", { now: T0 });
      const later = { now: T0 + 120_000 };

      // Still there just before the expiry.
      expect((await status(id, { now: T0 + 119_999 })).status).toBe(200);

      // Read paths refuse it. Their background purge may already delete the row.
      expect((await status(id, later)).status).toBe(404);
      expect((await reveal(id, later)).status).toBe(404);
      expect(await rowCount()).toBe(0);
    });

    it("purges expired rows on create, keeping unexpired ones", async () => {
      const old = await createOk(blobOf(64), "60", { now: T0 });
      const fresh = await createOk(blobOf(64), "3600", { now: T0 });
      expect(await rowCount()).toBe(2);

      await createOk(blobOf(64), "60", { now: T0 + 61_000 });

      const ids = await h.ids();
      expect(ids).not.toContain(old);
      expect(ids).toContain(fresh);
      expect(ids).toHaveLength(2);
    });

    it("does not reveal an expired row that is still physically present", async () => {
      const id = await createOk(blobOf(64), "60", { now: T0 });
      await h.setExpiresAt(id, T0);
      const response = await call(`/api/secrets/${id}/reveal`, { method: "POST" }, { now: T0 + 1 });
      expect(response.status).toBe(404);
    });
  });

  function streamOf(total: number, chunk = 1024, pulled = { bytes: 0 }): ReadableStream<Uint8Array> {
    let sent = 0;
    return new ReadableStream({
      pull(controller) {
        const size = Math.min(chunk, total - sent);
        if (size <= 0) return controller.close();
        pulled.bytes += size;
        sent += size;
        controller.enqueue(new Uint8Array(size).fill(7));
      },
    });
  }

  describe("body size", () => {
    const streamed = (body: ReadableStream<Uint8Array>) =>
      call("/api/secrets?ttl=3600", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body,
        duplex: "half",
      } as RequestInit);

    it("rejects an over-limit streamed body without Content-Length, stores nothing and stops reading early", async () => {
      const before = await rowCount();
      const pulled = { bytes: 0 };
      const response = await streamed(streamOf(MAX_BLOB_BYTES * 50, 1024, pulled));
      expect(response.status).toBe(413);
      expect(await rowCount()).toBe(before);
      expect(pulled.bytes).toBeLessThan(MAX_BLOB_BYTES * 10);
    });

    it("accepts a streamed body within the limit and returns the same bytes", async () => {
      const blob = blobOf(5000);
      const id = await (async () => {
        const response = await streamed(
          new ReadableStream({
            start(controller) {
              for (let i = 0; i < blob.length; i += 700) controller.enqueue(blob.slice(i, i + 700));
              controller.close();
            },
          }),
        );
        expect(response.status).toBe(201);
        return ((await response.json()) as { id: string }).id;
      })();
      expect(new Uint8Array(await (await reveal(id)).arrayBuffer())).toEqual(blob);
    });

    it("accepts a streamed body of exactly the largest size", async () => {
      expect((await streamed(streamOf(MAX_BLOB_BYTES))).status).toBe(201);
    });

    it("answers 400 for a missing body", async () => {
      const response = await call("/api/secrets?ttl=3600", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
      });
      expect(response.status).toBe(400);
    });

    it("rejects a Content-Length that understates the real size", async () => {
      const response = await call("/api/secrets?ttl=3600", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "Content-Length": "100" },
        body: blobOf(MAX_BLOB_BYTES + 500),
      });
      // The runtime may refuse to build the request or fix the header; either way it must not be stored.
      expect([201, 400, 413]).toContain(response.status);
      if (response.status === 201) expect(await rowCount()).toBeGreaterThan(0);
    });

    it("sends the API security headers on success and error responses", async () => {
      const id = await createOk();
      for (const response of [
        await create(blobOf(64)),
        await create(blobOf(64), { ttl: "x" }),
        await call("/api/secrets"),
        await call(`/api/secrets/${id}`),
        await call(`/api/secrets/${id}/reveal`),
        await reveal(id),
        await reveal(id),
      ]) {
        expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'; frame-ancestors 'none'");
        expect(response.headers.get("Strict-Transport-Security")).toBe("max-age=31536000; includeSubDomains");
        expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
        await response.arrayBuffer();
      }
    });

    it("sends no-store on error responses", async () => {
      for (const response of [
        await create(blobOf(64), { ttl: "x" }),
        await create(blobOf(MAX_BLOB_BYTES + 1)),
        await call("/api/secrets"),
        await call("/api/nope"),
        await reveal("A".repeat(22)),
      ]) {
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(response.headers.get("X-Robots-Tag")).toBe("noindex");
      }
    });
  });

  describe("validation", () => {
    it.each(["1e3", " 3600 ", "0x3c0", "+3600", "3600.0", "٣٦٠٠"])("rejects non-decimal ttl %j", async (ttl) => {
      expect((await create(blobOf(64), { ttl: encodeURIComponent(ttl) })).status).toBe(400);
    });

    it("accepts a plain decimal ttl with leading zeros", async () => {
      expect((await create(blobOf(64), { ttl: "003600" })).status).toBe(201);
    });

    it.each(["", "abc", "59", "1.5", String(MAX_TTL_SECONDS + 1), "-3600"])("rejects ttl %j", async (ttl) => {
      expect((await create(blobOf(64), { ttl })).status).toBe(400);
    });

    it("accepts the largest blob and rejects one byte more", async () => {
      expect((await create(blobOf(MAX_BLOB_BYTES))).status).toBe(201);
      expect((await create(blobOf(MAX_BLOB_BYTES + 1))).status).toBe(413);
    });

    it("with large blobs off, takes exactly 16,418 bytes (the largest v2 text blob) and refuses 16,419 with 413", async () => {
      const options = { maxLargeBytes: 0 };
      expect((await create(blobOf(16_418), { options })).status).toBe(201);
      expect((await create(blobOf(16_419), { options })).status).toBe(413);
    });

    it("takes exactly 262,562 bytes (the largest hosted file blob, 256 KiB) and refuses 262,563 with 413", async () => {
      expect(MAX_BLOB_BYTES).toBe(262_562);
      expect((await create(blobOf(262_562), { ttl: "3600" })).status).toBe(201);
      const before = await rowCount();
      expect((await create(blobOf(262_563), { ttl: "3600" })).status).toBe(413);
      expect(await rowCount()).toBe(before);
    });

    it("takes a larger file blob when the router is told a higher file limit (self-host), up to that limit's blob size", async () => {
      const options = { maxFileBytes: 1024 * 1024 };
      expect((await create(blobOf(1_048_994), { ttl: "3600", options })).status).toBe(201);
      expect((await create(blobOf(1_048_995), { ttl: "3600", options })).status).toBe(413);
    });

    it("with a small maxFileBytes (1000) still stores a 16 KB text (16,418-byte blob) and refuses 16,419 with 413", async () => {
      const options = { maxFileBytes: 1000 };
      expect((await create(blobOf(16_418), { options })).status).toBe(201);
      const refused = await create(blobOf(16_419), { options });
      expect(refused.status).toBe(413);
      await refused.arrayBuffer();
      expect(((await (await call("/api/limits", {}, options)).json()) as { maxFileBytes: number }).maxFileBytes).toBe(1000);
    });

    it("with files off (maxFileBytes 0) takes 16,418 bytes and answers 413 for 16,419", async () => {
      const options = { maxFileBytes: 0 };
      expect((await create(blobOf(16_418), { options })).status).toBe(201);
      expect((await create(blobOf(16_419), { options })).status).toBe(413);
    });

    it("rejects a blob too small to hold any ciphertext", async () => {
      expect((await create(blobOf(28))).status).toBe(400);
    });

    it("requires an octet-stream body", async () => {
      const response = await create("text", { headers: { "Content-Type": "text/plain" } });
      expect(response.status).toBe(415);
    });

    it("answers 404 for malformed ids and unknown paths", async () => {
      expect((await status("short")).status).toBe(404);
      expect((await reveal("x".repeat(23))).status).toBe(404);
      expect((await status("A".repeat(22))).status).toBe(404);
      expect((await call("/api/other")).status).toBe(404);
    });

    it("rejects wrong methods", async () => {
      expect((await call("/api/secrets")).status).toBe(405);
      const id = await createOk();
      expect((await call(`/api/secrets/${id}`, { method: "DELETE" })).status).toBe(405);
    });
  });

  describe("usage counters", () => {
    const recorder = () => {
      const calls: [string, string][] = [];
      const usage: Usage = { count: (event, label) => void calls.push([event, label]) };
      return { calls, options: { usage } as Options };
    };
    const kinds = ["text", "text-pass", "file", "file-pass"];
    const createKind = (kind: string, options?: Options, blob = blobOf(64), ttl = "3600") =>
      call(`/api/secrets?ttl=${ttl}&kind=${kind}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: blob }, options);

    it.each(kinds)("counts a created %s once", async (kind) => {
      const r = recorder();
      expect((await createKind(kind, r.options)).status).toBe(201);
      expect(r.calls).toEqual([["create", kind]]);
    });

    it.each([
      ["no kind", ""],
      ["an empty kind", "&kind="],
      ["a wrong case", "&kind=TEXT"],
      ["an invalid first value", "&kind=bogus&kind=text"],
      ["a 300 character value", `&kind=${"a".repeat(300)}`],
      ["a NUL byte", "&kind=%00"],
    ])("counts %s as unknown and answers as without kind", async (_name, query) => {
      const r = recorder();
      const plain = await call("/api/secrets?ttl=3600", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: blobOf(64) });
      const response = await call(`/api/secrets?ttl=3600${query}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: blobOf(64) }, r.options);
      expect(response.status).toBe(201);
      expect(r.calls).toEqual([["create", "unknown"]]);
      expect([...response.headers].sort()).toEqual([...plain.headers].sort());
      expect(Object.keys((await response.json()) as object)).toEqual(Object.keys((await plain.json()) as object));
    });

    it("counts nothing for refused creates (400, 409, 413, 415, 503)", async () => {
      const r = recorder();
      const o = r.options;
      expect((await createKind("text", o, blobOf(64), "5")).status).toBe(400);
      expect((await createKind("text", o, new Uint8Array(0))).status).toBe(400);
      expect((await createKind("text", o, blobOf(MAX_TEXT_BLOB_BYTES + 1), String(LARGE_MAX_TTL_SECONDS + 1))).status).toBe(409);
      expect((await createKind("text", o, blobOf(MAX_BLOB_BYTES + 1))).status).toBe(413);
      expect((await call("/api/secrets?ttl=3600&kind=text", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" }, o)).status).toBe(415);
      expect((await createKind("text", { ...o, maxStored: 0 })).status).toBe(503);
      expect(r.calls).toEqual([]);
    });

    it("counts nothing for a near-full 409", async () => {
      const r = recorder();
      await createOk(blobOf(64));
      await createOk(blobOf(64));
      const response = await createKind("text", { ...r.options, maxStored: 2 }, blobOf(64), String(NEAR_FULL_MAX_TTL_SECONDS + 1));
      expect(response.status).toBe(409);
      expect(r.calls).toEqual([]);
    });

    it("counts a reveal, then a gone, with the kind or unknown", async () => {
      const r = recorder();
      const blob = blobOf(100);
      const id = await createOk(blob);
      const first = await call(`/api/secrets/${id}/reveal?kind=file-pass`, { method: "POST" }, r.options);
      expect(first.status).toBe(200);
      expect(new Uint8Array(await first.arrayBuffer())).toEqual(blob);
      const second = await call(`/api/secrets/${id}/reveal?kind=file-pass`, { method: "POST" }, r.options);
      expect(second.status).toBe(404);
      expect(r.calls).toEqual([["reveal", "file-pass"], ["gone", "file-pass"]]);

      const r2 = recorder();
      const id2 = await createOk();
      await call(`/api/secrets/${id2}/reveal`, { method: "POST" }, r2.options);
      await call(`/api/secrets/${id2}/reveal?kind=nope`, { method: "POST" }, r2.options);
      expect(r2.calls).toEqual([["reveal", "unknown"], ["gone", "unknown"]]);
    });

    it("counts an expired secret as gone", async () => {
      const T0 = 1_800_000_000_000;
      const r = recorder();
      const id = await createOk(blobOf(64), "60", { now: T0 });
      await call(`/api/secrets/${id}/reveal?kind=text`, { method: "POST" }, { ...r.options, now: T0 + 61_000 });
      expect(r.calls).toEqual([["gone", "text"]]);
    });

    it("counts nothing for status, GET on reveal, other methods and malformed ids", async () => {
      const r = recorder();
      const id = await createOk();
      expect((await call(`/api/secrets/${id}`, {}, r.options)).status).toBe(200);
      expect((await call(`/api/secrets/${"z".repeat(22)}`, {}, r.options)).status).toBe(404);
      expect((await call(`/api/secrets/${id}/reveal?kind=text`, {}, r.options)).status).toBe(405);
      expect((await call(`/api/secrets/${id}`, { method: "POST" }, r.options)).status).toBe(405);
      expect((await call("/api/secrets/short/reveal?kind=text", { method: "POST" }, r.options)).status).toBe(404);
      expect((await call("/api/secrets/a$b/reveal", { method: "POST" }, r.options)).status).toBe(404);
      expect(r.calls).toEqual([]);
      expect((await call(`/api/secrets/${id}`, {}, r.options)).status).toBe(200);
    });

    it("20 concurrent reveals give exactly one reveal and 19 gone", async () => {
      const r = recorder();
      const id = await createOk();
      const responses = await Promise.all(Array.from({ length: 20 }, () => call(`/api/secrets/${id}/reveal?kind=text`, { method: "POST" }, r.options)));
      expect(responses.filter((x) => x.status === 200)).toHaveLength(1);
      expect(r.calls.filter(([e]) => e === "reveal")).toEqual([["reveal", "text"]]);
      expect(r.calls.filter(([e]) => e === "gone")).toHaveLength(19);
    });

    it("a sink that throws changes no response", async () => {
      const throwing: Options = { usage: { count: () => { throw new Error("sink down"); } } };
      const blob = blobOf(90);
      const response = await createKind("text", throwing, blob);
      expect(response.status).toBe(201);
      const { id } = (await response.json()) as { id: string };
      const first = await call(`/api/secrets/${id}/reveal?kind=text`, { method: "POST" }, throwing);
      expect(first.status).toBe(200);
      expect(new Uint8Array(await first.arrayBuffer())).toEqual(blob);
      const second = await call(`/api/secrets/${id}/reveal?kind=text`, { method: "POST" }, throwing);
      expect(second.status).toBe(404);
      expect(await second.json()).toEqual({ error: "This secret was already opened or has expired" });
      const limits = await call("/api/limits?view=app", { headers: { "Sec-Fetch-Site": "same-origin" } }, throwing);
      expect(limits.status).toBe(200);
      expect(await limits.json()).toEqual(await (await call("/api/limits")).json());
    });

    it("the counted values hold no id, key or blob bytes and stay in the closed set", async () => {
      const r = recorder();
      const blob = blobOf(120);
      const key = "k".repeat(43);
      const response = await createKind("text-pass", r.options, blob);
      const { id } = (await response.json()) as { id: string };
      await call(`/api/secrets/${id}/reveal?kind=text-pass`, { method: "POST" }, r.options);
      await call(`/api/secrets/${id}/reveal?kind=text-pass`, { method: "POST" }, r.options);
      const text = JSON.stringify(r.calls);
      expect(text).not.toContain(id);
      expect(text).not.toContain(key);
      expect(text).not.toContain(btoa(String.fromCharCode(...blob.subarray(0, 12))));
      const allowed = new Set(["text", "text-pass", "file", "file-pass", "unknown"]);
      for (const [event, label] of r.calls) {
        expect(["create", "reveal", "gone"]).toContain(event);
        expect(allowed.has(label)).toBe(true);
      }
    });
  });

  describe("GET /api/limits", () => {
    it("answers the hosted limits as small JSON with the API headers", async () => {
      const response = await call("/api/limits");
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("X-Robots-Tag")).toBe("noindex");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Content-Type")).toMatch(/^application\/json/);
      expect(await response.json()).toEqual({ maxFileBytes: 262_144, maxFileTtl: 3600, maxTextBytes: 16_384 });
    });

    it("is built from the router options", async () => {
      const response = await call("/api/limits", {}, { maxFileBytes: 5_242_880, maxFileTtl: 86_400 });
      expect(await response.json()).toEqual({ maxFileBytes: 5_242_880, maxFileTtl: 86_400, maxTextBytes: 16_384 });
    });

    it("reports maxFileBytes 0 when files are off, by either setting", async () => {
      expect(((await (await call("/api/limits", {}, { maxFileBytes: 0 })).json()) as { maxFileBytes: number }).maxFileBytes).toBe(0);
      expect(((await (await call("/api/limits", {}, { maxLargeBytes: 0 })).json()) as { maxFileBytes: number }).maxFileBytes).toBe(0);
    });

    it("takes only GET, touches nothing and does not depend on the store", async () => {
      const before = await rowCount();
      for (const method of ["POST", "DELETE", "PUT"]) {
        const response = await call("/api/limits", { method });
        expect(response.status).toBe(405);
        expect(response.headers.get("Allow")).toBe("GET");
        await response.arrayBuffer();
      }
      expect((await call("/api/limits/extra")).status).toBe(404);
      expect(await rowCount()).toBe(before);
    });
  });

  describe("byte budget and large blobs", () => {
    const WEEK = String(MAX_TTL_SECONDS);
    const LARGE = MAX_TEXT_BLOB_BYTES + 1; // 16,419: the smallest large blob

    async function empty(): Promise<void> {
      for (const id of await h.ids()) await reveal(id);
      expect(await rowCount()).toBe(0);
    }

    it("has the documented budgets", () => {
      expect(MAX_TEXT_BLOB_BYTES).toBe(16_418);
      expect(MAX_STORED_BYTES).toBe(400_000_000);
      expect(MAX_LARGE_STORED_BYTES).toBe(200_000_000);
      expect(LARGE_MAX_TTL_SECONDS).toBe(3600);
    });

    it("answers 409 with maxTtl 3600 for a large blob that would last longer than an hour, and stores nothing", async () => {
      await empty();
      for (const ttl of [WEEK, "86400", "3601"]) {
        const response = await create(blobOf(LARGE), { ttl });
        expect(response.status).toBe(409);
        expect(response.headers.get("Retry-After")).toBeNull();
        const body = (await response.json()) as { error: string; maxTtl: number };
        expect(body.maxTtl).toBe(3600);
        expect(body.error).toBe("Secrets larger than 16 KB can last at most 1 hour.");
      }
      expect(await rowCount()).toBe(0);
      // One hour is fine, and so is a 7-day blob of exactly 16,418 bytes (not large).
      expect((await create(blobOf(LARGE), { ttl: "3600" })).status).toBe(201);
      expect((await create(blobOf(LARGE), { ttl: "60" })).status).toBe(201);
      expect((await create(blobOf(MAX_TEXT_BLOB_BYTES), { ttl: WEEK })).status).toBe(201);
      await empty();
    });

    it("lets a router with maxFileTtl 86400 (self-host) keep large blobs for a day and answers 409 with that value above it", async () => {
      await empty();
      const options = { maxFileTtl: 86_400 };
      expect((await create(blobOf(LARGE), { ttl: "86400", options })).status).toBe(201);
      const response = await create(blobOf(LARGE), { ttl: "86401", options });
      expect(response.status).toBe(409);
      const body = (await response.json()) as { error: string; maxTtl: number };
      expect(body.maxTtl).toBe(86_400);
      expect(body.error).toBe("Secrets larger than 16 KB can last at most 1 day.");
      await empty();
    });

    it("round trips a large blob byte for byte and keeps the byte counter exact", async () => {
      await empty();
      const blob = blobOf(70_000);
      const id = await createOk(blob, "3600");
      expect(await h.storedBytes()).toBe(70_000);
      expect(new Uint8Array(await (await reveal(id)).arrayBuffer())).toEqual(blob);
      expect(await h.storedBytes()).toBe(0);
      expect(await h.storedCounter()).toBe(0);
    });

    it("refuses a large blob at the large cap with 503 while a small one still fits", async () => {
      await empty();
      const options = { maxStoredBytes: 100_000, maxLargeBytes: 30_000 };
      expect((await create(blobOf(20_000), { ttl: "3600", options })).status).toBe(201);
      const refused = await create(blobOf(20_000), { ttl: "3600", options });
      expect(refused.status).toBe(503);
      expect(refused.headers.get("Retry-After")).toBe("300");
      await refused.arrayBuffer();
      expect(await rowCount()).toBe(1);
      expect((await create(blobOf(64), { ttl: "3600", options })).status).toBe(201);
      expect(await h.storedBytes()).toBe(20_064);
      // The large cap counts all bytes, so a large blob needs room including the small ones.
      expect((await create(blobOf(LARGE), { ttl: "3600", options: { ...options, maxLargeBytes: 40_000 } })).status).toBe(201);
      expect((await create(blobOf(LARGE), { ttl: "3600", options: { ...options, maxLargeBytes: 40_000 } })).status).toBe(503);
      await empty();
    });

    it("keeps the rest of the budget for small blobs once large ones stop", async () => {
      await empty();
      const options = { maxStoredBytes: 60_000, maxLargeBytes: 20_000 };
      expect((await create(blobOf(17_000), { ttl: "3600", options })).status).toBe(201);
      expect((await create(blobOf(17_000), { ttl: "3600", options })).status).toBe(503);
      for (let i = 0; i < 4; i++) expect((await create(blobOf(10_000), { ttl: "3600", options })).status).toBe(201);
      // 17,000 + 40,000 = 57,000: another 10,000 would pass 60,000.
      expect((await create(blobOf(10_000), { ttl: "3600", options })).status).toBe(503);
      expect(await h.storedBytes()).toBe(57_000);
      await empty();
    });

    it("lets exactly the budget of simultaneous large creates in", async () => {
      await empty();
      const options = { maxStoredBytes: 1_000_000, maxLargeBytes: 100_000 };
      const responses = await Promise.all(Array.from({ length: 12 }, () => create(blobOf(20_000), { ttl: "3600", options })));
      const codes = responses.map((r) => r.status).sort();
      await Promise.all(responses.map((r) => r.arrayBuffer()));
      expect(codes).toEqual([201, 201, 201, 201, 201, ...Array<number>(7).fill(503)]);
      expect(await h.storedBytes()).toBe(100_000);
      await empty();
    });

    it("refuses long TTLs with 409 above 80 % of the bytes, but not 1 day or shorter", async () => {
      await empty();
      const options = { maxStoredBytes: 1000 };
      expect((await create(blobOf(300), { ttl: WEEK, options })).status).toBe(201);
      expect((await create(blobOf(300), { ttl: WEEK, options })).status).toBe(201);
      const refused = await create(blobOf(300), { ttl: WEEK, options });
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { maxTtl: number }).maxTtl).toBe(86_400);
      expect((await create(blobOf(300), { ttl: "86400", options })).status).toBe(201);
      const full = await create(blobOf(300), { ttl: "3600", options });
      expect(full.status).toBe(503);
      await full.arrayBuffer();
      expect(await h.storedBytes()).toBe(900);
      await empty();
    });

    it("with large blobs off (maxLargeBytes 0) takes 16,418 bytes and answers 413 for 16,419", async () => {
      await empty();
      const options = { maxLargeBytes: 0 };
      expect((await create(blobOf(MAX_TEXT_BLOB_BYTES), { options })).status).toBe(201);
      const response = await create(blobOf(LARGE), { options });
      expect(response.status).toBe(413);
      await response.arrayBuffer();
      const declared = await call("/api/secrets?ttl=3600", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "Content-Length": String(LARGE) },
        body: blobOf(LARGE),
      }, options);
      expect(declared.status).toBe(413);
      await empty();
    });

    it("enforces a lower hosted maximum independently of the format maximum", async () => {
      await empty();
      const options = { maxBlobBytes: 65_954 };
      expect((await create(blobOf(65_954), { options })).status).toBe(201);
      expect((await create(blobOf(65_955), { options })).status).toBe(413);
      await empty();
    });

    it("keeps stats.stored and stats.bytes equal to COUNT(*) and SUM(length(blob)) after 30 concurrent mixed operations", async () => {
      await empty();
      const T0 = 1_800_000_000_000;
      const old = await Promise.all(Array.from({ length: 4 }, (_, i) => createOk(blobOf(100 + i), "60", { now: T0 })));
      const keep = await Promise.all(Array.from({ length: 6 }, (_, i) => createOk(blobOf(i % 2 === 0 ? 20_000 + i : 500 + i), "3600", { now: T0 })));
      expect(await h.storedBytes()).toBe(await h.sumBlobBytes());

      const later = { now: T0 + 61_000 };
      const sizes = [64, 20_000, 300, 17_000, 5000];
      const operations: Array<Promise<Response>> = [
        // 12 creates, large and small, one of which purges the 60-second rows; some refused by the byte cap.
        ...Array.from({ length: 12 }, (_, i) =>
          create(blobOf(sizes[i % sizes.length]!), { ttl: "3600", options: { ...later, maxStoredBytes: 140_000, maxLargeBytes: 100_000 } }),
        ),
        // 12 reveals, six of them double reveals of the same row.
        ...keep.slice(0, 6).flatMap((id) => [reveal(id, later), reveal(id, later)]),
        // 6 reveals of expired rows (404) and status reads.
        ...old.slice(0, 2).flatMap((id) => [reveal(id, later), status(id, later)]),
        reveal("A".repeat(22), later),
        reveal("B".repeat(22), later),
      ];
      expect(operations).toHaveLength(30);
      for (const response of await Promise.all(operations)) await response.arrayBuffer();

      expect(await h.storedCounter()).toBe(await rowCount());
      expect(await h.storedBytes()).toBe(await h.sumBlobBytes());
      expect(await h.storedBytes()).toBeLessThanOrEqual(140_000);
      expect((await h.ids()).filter((id) => old.includes(id))).toEqual([]);
      await empty();
      expect(await h.storedBytes()).toBe(0);
    });

    it("does not move the byte counter for a refused create", async () => {
      await empty();
      await createOk(blobOf(500));
      const before = await h.storedBytes();
      expect((await create(blobOf(500), { options: { maxStoredBytes: before } })).status).toBe(503);
      expect(await h.storedBytes()).toBe(before);
      await empty();
    });
  });

  describe("near-full rule", () => {
    const WEEK = String(MAX_TTL_SECONDS);

    /** Empties the table by revealing every row (the D1 table is shared between tests). */
    async function empty(): Promise<void> {
      for (const id of await h.ids()) await reveal(id);
      expect(await rowCount()).toBe(0);
    }

    it("computes the long-TTL cap as 80 % of the cap, at least 1", () => {
      expect(NEAR_FULL_MAX_TTL_SECONDS).toBe(86_400);
      expect(longTtlCap(20_000)).toBe(16_000);
      expect(longTtlCap(5)).toBe(4);
      expect(longTtlCap(1)).toBe(1);
      expect(longTtlCap(2)).toBe(1);
    });

    it("refuses long TTLs with 409 and maxTtl above 80 %, but not 1 day or shorter", async () => {
      await empty();
      const options = { maxStored: 5 };
      for (let i = 0; i < 4; i++) expect((await create(blobOf(64), { ttl: WEEK, options })).status).toBe(201);

      const refused = await create(blobOf(64), { ttl: WEEK, options });
      expect(refused.status).toBe(409);
      expect(refused.headers.get("Retry-After")).toBeNull();
      const body = (await refused.json()) as { error: string; maxTtl: number };
      expect(body.maxTtl).toBe(86_400);
      expect(body.error).toMatch(/nearly full/);
      expect(await rowCount()).toBe(4);

      expect((await create(blobOf(64), { ttl: "86400", options })).status).toBe(201);
      expect((await create(blobOf(64), { ttl: "86401", options })).status).toBe(409);
      expect(await rowCount()).toBe(5);

      // Completely full: short TTLs get 503.
      expect((await create(blobOf(64), { ttl: "3600", options })).status).toBe(503);
      await empty();
    });

    it("lets exactly the long-TTL cap of simultaneous 7-day creates in", async () => {
      await empty();
      const options = { maxStored: 5 };
      const responses = await Promise.all(Array.from({ length: 20 }, () => create(blobOf(64), { ttl: WEEK, options })));
      const codes = responses.map((r) => r.status).sort();
      await Promise.all(responses.map((r) => r.arrayBuffer()));
      expect(codes).toEqual([201, 201, 201, 201, ...Array<number>(16).fill(409)]);
      expect(await rowCount()).toBe(4);
      await empty();
    });

    it("with a cap of 1 the long-TTL cap is 1", async () => {
      await empty();
      const options = { maxStored: 1 };
      expect((await create(blobOf(64), { ttl: WEEK, options })).status).toBe(201);
      expect((await create(blobOf(64), { ttl: WEEK, options })).status).toBe(409);
      await empty();
    });
  });

  describe("global cap", () => {
    it("has a cap of 20000", () => {
      expect(MAX_STORED_SECRETS).toBe(20_000);
    });

    it("answers 503 while the table holds the maximum of stored secrets", async () => {
      await createOk();
      const stored = await rowCount();
      const options = { maxStored: stored };
      const response = await create(blobOf(64), { options });
      expect(response.status).toBe(503);
      expect(((await response.json()) as { error: string }).error).toMatch(/full|busy|later/i);
      expect(await rowCount()).toBe(stored);

      // One more slot and it works again.
      expect((await create(blobOf(64), { options: { maxStored: stored + 1 } })).status).toBe(201);
    });

    it("lets exactly one of many simultaneous creates into a table with one free slot", async () => {
      // The D1 table is shared between tests, so "one free slot" is relative to what is stored now.
      const before = await rowCount();
      const options = { maxStored: before + 1 };
      const responses = await Promise.all(Array.from({ length: 10 }, () => create(blobOf(64), { options })));
      const codes = responses.map((response) => response.status).sort();
      await Promise.all(responses.map((response) => response.arrayBuffer()));
      expect(codes).toEqual([201, ...Array<number>(9).fill(503)]);
      expect(await rowCount()).toBe(before + 1);
    });

    it("keeps stats.stored equal to COUNT(*) after mixed concurrent create, reveal and expiry purge", async () => {
      const T0 = 1_800_000_000_000;
      expect(await h.storedCounter()).toBe(await rowCount());
      const old = await Promise.all(Array.from({ length: 5 }, () => createOk(blobOf(64), "60", { now: T0 })));
      const keep = await Promise.all(Array.from({ length: 5 }, () => createOk(blobOf(64), "3600", { now: T0 })));
      expect(await h.storedCounter()).toBe(await rowCount());

      // Reveals (including double reveals of the same id), creates and a purging create, all at once.
      await Promise.all([
        ...keep.slice(0, 3).flatMap((id) => [reveal(id, { now: T0 }), reveal(id, { now: T0 })]),
        ...Array.from({ length: 4 }, () => create(blobOf(64), { ttl: "3600", options: { now: T0 + 61_000 } })),
        reveal(old[0]!, { now: T0 + 61_000 }),
      ].map(async (p) => (await p).arrayBuffer()));

      expect(await h.storedCounter()).toBe(await rowCount());
      expect((await h.ids()).filter((id) => old.includes(id))).toEqual([]);

      // Refused creates (cap reached) do not move the counter either.
      const stored = await rowCount();
      expect((await create(blobOf(64), { options: { maxStored: stored } })).status).toBe(503);
      expect(await h.storedCounter()).toBe(stored);
    });

    it("fails loudly with 500 for a missing counter row, also for large blobs, and recovers", async () => {
      await h.removeCounter();
      try {
        expect((await create(blobOf(MAX_TEXT_BLOB_BYTES + 1))).status).toBe(500);
      } finally {
        await h.restoreCounter();
      }
      expect(await h.storedBytes()).toBe(await h.sumBlobBytes());
    });

    it("fails loudly with 500, stores nothing and never fails open when the counter row is missing", async () => {
      const before = await rowCount();
      await h.removeCounter();
      try {
        const response = await create(blobOf(64));
        expect(response.status).toBe(500);
        expect(((await response.json()) as { error: string }).error).toMatch(/internal|error/i);
        expect(await rowCount()).toBe(before);
        // Even a huge cap must not let anything in without the counter.
        expect((await create(blobOf(64), { options: { maxStored: 10_000_000 } })).status).toBe(500);
        expect(await rowCount()).toBe(before);
      } finally {
        await h.restoreCounter();
      }
      expect(await h.storedCounter()).toBe(await rowCount());
      expect((await create(blobOf(64))).status).toBe(201);
    });

    it("a full table still answers 503, not 500, while the counter row exists", async () => {
      await createOk();
      expect((await create(blobOf(64), { options: { maxStored: await rowCount() } })).status).toBe(503);
    });

    it("does not count expired secrets towards the cap", async () => {
      const T0 = 1_800_000_000_000;
      await createOk(blobOf(64), "60", { now: T0 });
      const stored = await rowCount();
      const response = await create(blobOf(64), { options: { now: T0 + 61_000, maxStored: stored } });
      expect(response.status).toBe(201);
    });
  });
}

/** The SQL a store sent while it served one reveal (`take`) and one capped insert, each recorded separately. */
export interface IssuedSql {
  reveal: string[];
  insert: string[];
}

/** Structural guarantee behind the atomic claims: one statement each, and the reveal never SELECTs. */
export function expectAtomicSql({ reveal, insert }: IssuedSql): void {
  const squash = (sql: string) => sql.replace(/\s+/g, " ").trim();
  expect(reveal.map(squash)).toHaveLength(1);
  expect(reveal[0]).toMatch(/^DELETE FROM secrets WHERE id = \? AND expires_at > \? RETURNING blob$/i);
  expect(reveal.join(" ")).not.toMatch(/\bselect\b/i);
  expect(insert.map(squash)).toHaveLength(1);
  expect(insert[0]).toMatch(/^INSERT INTO secrets \(id, blob, expires_at\) SELECT \S+, \S+, \S+ WHERE \(SELECT stored < \S+ AND bytes \+ length\(\S+\) <= \S+ FROM stats WHERE id = 1\)$/i);
}
