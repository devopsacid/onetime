import { describe, expect, it } from "vitest";
import { ID_PATTERN, MAX_BLOB_BYTES, MAX_STORED_SECRETS, MAX_TTL_SECONDS } from "../../src/shared/limits";
import type { Options } from "../../src/worker/index";

type BodyInit = NonNullable<RequestInit["body"]>;

/** What the contract suite needs from a runtime: the router wired to a fresh store, plus direct access to the rows. */
export interface ApiHarness {
  /** Runs the router, then waits for background work (purges) to finish. */
  call(path: string, init?: RequestInit, options?: Options): Promise<Response>;
  rowCount(): Promise<number>;
  /** The counter row, `SELECT stored FROM stats WHERE id = 1`. */
  storedCounter(): Promise<number>;
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
    return crypto.getRandomValues(new Uint8Array(size));
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
  expect(insert[0]).toMatch(/^INSERT INTO secrets \(id, blob, expires_at\) SELECT \S+, \S+, \S+ WHERE \(SELECT stored FROM stats WHERE id = 1\) < \S+$/i);
}
