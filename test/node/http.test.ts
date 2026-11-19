import { spawn } from "node:child_process";
import { request as httpRequest, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../server/http";
import { loadSite } from "../../server/static";
import { openSqliteStore, type SqliteStore } from "../../server/store-sqlite";
import { MAX_BLOB_BYTES } from "../../src/shared/limits";
import { makeDist, migrations, tempDir } from "./helpers";

const tmp = tempDir();
let store: SqliteStore;
let server: Server;
let drain: () => Promise<void>;
let base: string;
let port: number;
let bytesReadAtFinish: number[] = [];
let statusAtFinish: number[] = [];

beforeAll(async () => {
  store = openSqliteStore(join(tmp.path, "http.db"), migrations());
  const app = createApp({ store, site: loadSite(makeDist(tmp.path)), maxStored: 20_000 });
  server = app.server;
  drain = app.drain;
  server.on("request", (req, res) => {
    res.on("finish", () => statusAtFinish.push(res.statusCode));
    res.on("close", () => bytesReadAtFinish.push(req.socket.bytesRead));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await drain();
  await store.close();
  tmp.remove();
});
afterEach(() => {
  bytesReadAtFinish = [];
  statusAtFinish = [];
  vi.restoreAllMocks();
});

const blobOf = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const create = (body: Uint8Array, ttl = 3600) =>
  fetch(`${base}/api/secrets?ttl=${ttl}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body });

interface Raw {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  serverBytesRead: number;
}

/** Sends `total` bytes as a chunked body in 1 KB pieces, stopping when the server stops reading or closes. */
function sendChunked(path: string, total: number, tolerant = false): Promise<Raw> {
  return new Promise((resolve, reject) => {
    bytesReadAtFinish = [];
    statusAtFinish = [];
    const req = httpRequest({ host: "127.0.0.1", port, method: "POST", path, headers: { "Content-Type": "application/octet-stream" } });
    let finished = false;
    // tolerant: a write error or reset before the response is not a failure; wait for the server to finish the request.
    const settle = (status: number, headers: Raw["headers"], body: string): void => {
      finished = true;
      const started = Date.now();
      const poll = (): void => {
        if (bytesReadAtFinish.length > 0 && statusAtFinish.length > 0) return resolve({ status, headers, body, serverBytesRead: bytesReadAtFinish[0] ?? -1 });
        if (Date.now() - started > 5000) return resolve({ status, headers, body, serverBytesRead: -1 });
        setTimeout(poll, 20);
      };
      poll();
    };
    req.on("response", (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        req.destroy();
        settle(res.statusCode!, res.headers, body);
      });
    });
    req.on("error", (e) => {
      if (finished) return;
      if (tolerant) return settle(0, {}, "");
      reject(e);
    });
    let sent = 0;
    const chunk = Buffer.alloc(1024, 7);
    const pump = () => {
      while (!finished && sent < total) {
        sent += chunk.length;
        if (!req.write(chunk)) return void req.once("drain", pump);
      }
      if (!finished) req.end();
    };
    pump();
  });
}

describe("API bridge", () => {
  it("round-trips a secret and burns it only on POST reveal", async () => {
    const blob = blobOf(300);
    const created = await create(blob);
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    expect((await fetch(`${base}/api/secrets/${id}`)).status).toBe(200);
    const preview = await fetch(`${base}/api/secrets/${id}/reveal`);
    expect(preview.status).toBe(405);
    expect(preview.headers.get("allow")).toBe("POST");
    expect((await fetch(`${base}/api/secrets/${id}`)).status).toBe(200);

    const first = await fetch(`${base}/api/secrets/${id}/reveal`, { method: "POST" });
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("application/octet-stream");
    expect(first.headers.get("content-length")).toBe(String(blob.length));
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(blob);
    expect((await fetch(`${base}/api/secrets/${id}/reveal`, { method: "POST" })).status).toBe(404);
  });

  it("returns every byte value unchanged", async () => {
    const blob = new Uint8Array(300);
    for (let i = 0; i < blob.length; i++) blob[i] = i % 256;
    const { id } = (await (await create(blob)).json()) as { id: string };
    const r = await fetch(`${base}/api/secrets/${id}/reveal`, { method: "POST" });
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(blob);
  });

  it("accepts a chunked upload within the limit", async () => {
    const r = await sendChunked("/api/secrets?ttl=3600", 4096);
    expect(r.status).toBe(201);
  });

  it("carries the API headers and no CSP on API responses, success or error", async () => {
    for (const r of [await create(blobOf(64)), await fetch(`${base}/api/secrets`), await fetch(`${base}/api/nope`), await fetch(`${base}/api`)]) {
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.headers.get("x-robots-tag")).toBe("noindex");
      expect(r.headers.get("content-security-policy")).toBeNull();
      await r.arrayBuffer();
    }
    expect((await fetch(`${base}/api`)).status).toBe(404);
  });

  it("answers an over-limit chunked body with a 413 response and stops reading after a bounded drain", async () => {
    // Asserted on the server side: client and server share this event loop, so under load the server's drain fallback can
    // destroy the socket while this client still writes (EPIPE). Delivery of the 413 to a client is proven out of process below.
    const r = await sendChunked("/api/secrets?ttl=3600", MAX_BLOB_BYTES * 1000, true);
    expect(statusAtFinish).toEqual([413]);
    expect(r.serverBytesRead).toBeGreaterThan(0);
    expect(r.serverBytesRead).toBeLessThan(3 * 1024 * 1024);
    if (r.status !== 0) {
      expect(r.status).toBe(413);
      expect(r.headers["connection"]).toBe("close");
      expect(JSON.parse(r.body)).toEqual({ error: "Secret is too large" });
    }
  });

  it("delivers the 413 to a client in another process that writes the whole over-limit body before it reads", async () => {
    // A raw socket: send everything, only then read. A server that closes at once would reset the connection and lose the 413.
    const script = `
      const net = require("node:net");
      const [port, mode, size] = process.argv.slice(1);
      const total = Number(size);
      const s = net.connect(Number(port), "127.0.0.1");
      let got = "";
      s.on("data", (d) => (got += d));
      s.on("error", () => {});
      s.on("close", () => { console.log(got.split("\\r\\n")[0]); process.exit(0); });
      const body = Buffer.alloc(total, 7);
      const head = "POST /api/secrets?ttl=3600 HTTP/1.1\\r\\nHost: x\\r\\nContent-Type: application/octet-stream\\r\\n" +
        (mode === "chunked" ? "Transfer-Encoding: chunked\\r\\n\\r\\n" : "Content-Length: " + total + "\\r\\n\\r\\n");
      s.pause();
      s.write(head);
      if (mode === "chunked") {
        for (let i = 0; i < total; i += 4096) { const p = body.subarray(i, i + 4096); s.write(p.length.toString(16) + "\\r\\n"); s.write(p); s.write("\\r\\n"); }
        s.write("0\\r\\n\\r\\n");
      } else s.write(body);
      setTimeout(() => s.resume(), 300);
      setTimeout(() => process.exit(2), 5000);
    `;
    const run = (mode: string, size: number) =>
      new Promise<string>((resolve) => {
        const child = spawn(process.execPath, ["-e", script, String(port), mode, String(size)], { stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.on("close", () => resolve(out.trim()));
      });
    const results: string[] = [];
    for (let i = 0; i < 4; i++) {
      results.push(await run("chunked", 1024 * 1024), await run("length", 1024 * 1024));
    }
    expect(results).toEqual(Array(8).fill("HTTP/1.1 413 Payload Too Large"));
  }, 60_000);

  it("answers an honest oversized Content-Length with 413 without reading the body", async () => {
    const result = await new Promise<Raw>((resolve, reject) => {
      bytesReadAtFinish = [];
      const req = httpRequest({
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/api/secrets?ttl=3600",
        headers: { "Content-Type": "application/octet-stream", "Content-Length": String(MAX_BLOB_BYTES * 10) },
      });
      req.on("response", (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          req.destroy();
          setTimeout(() => resolve({ status: res.statusCode!, headers: res.headers, body, serverBytesRead: bytesReadAtFinish[0] ?? -1 }), 50);
        });
      });
      req.on("error", reject);
      req.write(Buffer.alloc(100, 1)); // a little body, the rest never comes
    });
    expect(result.status).toBe(413);
    expect(result.serverBytesRead).toBeLessThan(MAX_BLOB_BYTES);
  });

  it("stores nothing for a rejected upload and still serves the next request on a new connection", async () => {
    const before = (store.db.prepare("SELECT COUNT(*) AS n FROM secrets").get() as { n: number }).n;
    expect((await sendChunked("/api/secrets?ttl=3600", MAX_BLOB_BYTES * 30)).status).toBe(413);
    expect((store.db.prepare("SELECT COUNT(*) AS n FROM secrets").get() as { n: number }).n).toBe(before);
    expect((await create(blobOf(64))).status).toBe(201);
  });

  it("answers 415 and 400 without leaving the connection in a bad state", async () => {
    const bad = await fetch(`${base}/api/secrets?ttl=3600`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "hello" });
    expect(bad.status).toBe(415);
    expect((await fetch(`${base}/api/secrets?ttl=1`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: blobOf(64) })).status).toBe(400);
    expect((await create(blobOf(64))).status).toBe(201);
  });

  it("answers 500 with the API headers and logs one line without the path or id", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const app = createApp({
      store: { ...store, take: async () => Promise.reject(Object.assign(new Error("boom with id AAAAAAAAAAAAAAAAAAAAAA"), { code: "X_FAIL" })) },
      site: loadSite(makeDist(tempDir().path)),
      maxStored: 10,
    });
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    const p = (app.server.address() as AddressInfo).port;
    const r = await fetch(`http://127.0.0.1:${p}/api/secrets/AAAAAAAAAAAAAAAAAAAAAA/reveal`, { method: "POST" });
    expect(r.status).toBe(500);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-robots-tag")).toBe("noindex");
    expect(r.headers.get("content-security-policy")).toBeNull();
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    const lines = write.mock.calls.map((c) => String(c[0]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/AAAAAAAAAAAAAAAAAAAAAA|\/api\//);
    expect(lines[0]).toContain("X_FAIL");
  });
});

describe("deferred purge", () => {
  /** A store on its own file whose purge statement is spied on, plus a list of events in the order they happen. */
  function spied() {
    const dir = tempDir();
    const own = openSqliteStore(join(dir.path, "purge.db"), migrations());
    const events: string[] = [];
    const real = own.db.prepare.bind(own.db);
    own.db.prepare = ((sql: string) => {
      const statement = real(sql);
      if (!/^DELETE FROM secrets WHERE expires_at <= \?$/.test(sql)) return statement;
      const run = statement.run.bind(statement);
      statement.run = ((...args: Parameters<typeof run>) => (events.push("purge"), run(...args))) as typeof statement.run;
      return statement;
    }) as typeof own.db.prepare;
    return { own, events, dir };
  }

  it("does not run the purge inside the call that asks for it, but before the promise settles", async () => {
    const { own, events } = spied();
    const promise = own.purgeExpired(Date.now());
    expect(events).toEqual([]);
    await promise;
    expect(events).toEqual(["purge"]);
    await own.close();
  });

  it("writes the response of a status request before the purge runs", async () => {
    const { own, events } = spied();
    const app = createApp({ store: own, site: loadSite(makeDist(tempDir().path)), maxStored: 10 });
    app.server.on("request", (_req, res) => res.on("finish", () => events.push("response written")));
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    expect((await fetch(`${url}/api/secrets/AAAAAAAAAAAAAAAAAAAAAA`)).status).toBe(404);
    await app.drain();
    expect(events).toEqual(["response written", "purge"]);
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await own.close();
  });
});

describe("/healthz", () => {
  it("answers 200 ok with no-store and noindex for GET and HEAD, 405 for others", async () => {
    const get = await fetch(`${base}/healthz`);
    expect(get.status).toBe(200);
    expect(await get.text()).toBe("ok");
    expect(get.headers.get("cache-control")).toBe("no-store");
    expect(get.headers.get("x-robots-tag")).toBe("noindex");
    const head = await fetch(`${base}/healthz`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const post = await fetch(`${base}/healthz`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });

  it("answers 503 when the store does not respond", async () => {
    const app = createApp({
      store: { ...store, ping: async () => Promise.reject(new Error("down")) },
      site: loadSite(makeDist(tempDir().path)),
      maxStored: 10,
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    const r = await fetch(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/healthz`);
    expect(r.status).toBe(503);
    expect(r.headers.get("cache-control")).toBe("no-store");
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  });
});

describe("static through HTTP", () => {
  it("serves pages with the _headers rules and keeps them off the API", async () => {
    const root = await fetch(`${base}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(root.headers.get("cache-control")).toBe("no-store");
    expect(root.headers.get("content-length")).toBe(String((await root.arrayBuffer()).byteLength));
  });

  it("redirects, 404s, HEAD and 304 work", async () => {
    const redirect = await fetch(`${base}/how-it-works.html`, { redirect: "manual" });
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe("/how-it-works");
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    const head = await fetch(`${base}/robots.txt`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const etag = head.headers.get("etag")!;
    const cached = await fetch(`${base}/robots.txt`, { headers: { "If-None-Match": etag } });
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe("");
    expect((await fetch(`${base}/`, { method: "POST" })).status).toBe(405);
  });

  it("never serves _headers, _routes.json or _selfhost.json", async () => {
    for (const path of ["/_headers", "/_routes.json", "/_selfhost.json"]) expect((await fetch(`${base}${path}`)).status).toBe(404);
  });

  it("answers 400 for traversal and for a request target that is not a path", async () => {
    const reply = await new Promise<string>((resolve) => {
      const socket = connect(port, "127.0.0.1", () => socket.write("GET /%2e%2e/etc/passwd HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
      let data = "";
      socket.on("data", (d) => (data += d));
      socket.on("close", () => resolve(data));
    });
    expect(reply.startsWith("HTTP/1.1 400")).toBe(true);
    for (const target of ["http://evil.example/", "*"]) {
      const out = await new Promise<string>((resolve) => {
        const socket = connect(port, "127.0.0.1", () => socket.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
        let data = "";
        socket.on("data", (d) => (data += d));
        socket.on("close", () => resolve(data));
      });
      expect([target, out.startsWith("HTTP/1.1 400")]).toEqual([target, true]);
    }
  });

  it("answers a client that is too slow with 408 and closes, not with 400", async () => {
    const written: string[] = [];
    let destroyed = false;
    const socket = { writable: true, end: (text: string) => void written.push(text), destroy: () => void (destroyed = true) };
    const slow = Object.assign(new Error("timeout"), { code: "ERR_HTTP_REQUEST_TIMEOUT" });
    server.emit("clientError", slow, socket);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^HTTP\/1\.1 408 Request Timeout\r\n/);
    expect(written[0]).toMatch(/\r\nConnection: close\r\n/);
    const broken = Object.assign(new Error("bad"), { code: "HPE_INVALID_METHOD" });
    server.emit("clientError", broken, { ...socket, end: (text: string) => void written.push(text) });
    expect(written[1]).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
    server.emit("clientError", slow, { ...socket, writable: false });
    expect(destroyed).toBe(true);
  });

  it("answers 408 over a real socket that never finishes its headers", async () => {
    const reply = await new Promise<string>((resolve) => {
      const socket = connect(port, "127.0.0.1", () => socket.write("GET / HTTP/1.1\r\nHost: x\r\n"));
      let data = "";
      socket.on("data", (d) => (data += d));
      socket.on("close", () => resolve(data));
    });
    expect(reply.startsWith("HTTP/1.1 408")).toBe(true);
  }, 30_000);

  it("ignores the Host header", async () => {
    const reply = await new Promise<string>((resolve) => {
      const socket = connect(port, "127.0.0.1", () =>
        socket.write("GET /how-it-works.html HTTP/1.1\r\nHost: evil.example\r\nX-Forwarded-Host: evil.example\r\nX-Forwarded-For: 1.2.3.4\r\nConnection: close\r\n\r\n"),
      );
      let data = "";
      socket.on("data", (d) => (data += d));
      socket.on("close", () => resolve(data));
    });
    expect(reply).toMatch(/^HTTP\/1\.1 308/);
    expect(reply).toMatch(/\r\nlocation: \/how-it-works\r\n/i);
    expect(reply).not.toMatch(/evil\.example|1\.2\.3\.4/);
  });
});

describe("server settings and silence", () => {
  it("configures the timeouts and limits", () => {
    expect(server.requestTimeout).toBe(15_000);
    expect(server.headersTimeout).toBe(10_000);
    expect(server.keepAliveTimeout).toBe(5_000);
    expect(server.maxRequestsPerSocket).toBe(100);
  });

  it("writes nothing to stdout or stderr while serving requests", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { id } = (await (await create(blobOf(64))).json()) as { id: string };
    await fetch(`${base}/api/secrets/${id}`);
    await fetch(`${base}/api/secrets/${id}/reveal`, { method: "POST" });
    await fetch(`${base}/api/secrets/${id}/reveal`, { method: "POST" });
    await fetch(`${base}/`);
    await fetch(`${base}/nope`);
    await fetch(`${base}/healthz`);
    await sendChunked("/api/secrets?ttl=3600", MAX_BLOB_BYTES * 20);
    await drain();
    expect(out).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });
});
