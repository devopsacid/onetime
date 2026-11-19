import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openSqliteStore } from "../../server/store-sqlite";
import { MAX_BLOB_BYTES } from "../../src/shared/limits";
import { buildServerBundle, makeDist, migrations, expectExit, runServer, tempDir, waitListening, ROOT } from "./helpers";

const tmp = tempDir();
let bundle: string;
beforeAll(async () => {
  bundle = join(tmp.path, "dist-server", "server.mjs");
  await buildServerBundle(bundle);
  makeDist(tmp.path);
});
afterAll(() => tmp.remove());

const env = (db: string) => ({
  HOST: "127.0.0.1",
  PORT: "0",
  ONETIME_DB: db,
  ONETIME_DIST: join(tmp.path, "dist-selfhost"),
  // The bundle looks for migrations next to dist-server/; point at the real ones.
});

async function start(db: string) {
  const { cpSync } = await import("node:fs");
  cpSync(join(ROOT, "migrations"), join(tmp.path, "migrations"), { recursive: true });
  const child = runServer(bundle, env(db));
  await waitListening(child);
  const match = /127\.0\.0\.1:(\d+)/.exec(child.stdout());
  return { child, port: match ? Number(match[1]) : 0 };
}

describe("the built server process", () => {
  it("prints one startup line, then shuts down on SIGTERM after finishing a request in flight, closing the DB and releasing the lock", async () => {
    const db = join(tmp.path, "data", "s.db");
    const { child, port } = await start(db);
    expect(port).toBeGreaterThan(0);
    expect(child.stdout().trim().split("\n")).toHaveLength(1);
    expect(child.stdout()).toMatch(/onetime .*listening on 127\.0\.0\.1:\d+.*s\.db.*20000/);

    // Start an upload and leave it half-sent.
    const blob = Buffer.alloc(200, 9);
    const result = new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, method: "POST", path: "/api/secrets?ttl=3600", headers: { "Content-Type": "application/octet-stream", "Content-Length": String(blob.length) } });
      req.on("response", (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      });
      req.on("error", reject);
      req.write(blob.subarray(0, 100));
      setTimeout(() => req.end(blob.subarray(100)), 500);
    });
    await new Promise((r) => setTimeout(r, 150));
    child.process.kill("SIGTERM");

    const done = await result;
    expect(done.status).toBe(201);
    await expectExit(child, 0);
    expect(child.stdout().trim().split("\n")).toHaveLength(1);
    expect(child.stderr()).toBe("");

    // The lock is gone and the secret is in the file, with the WAL folded in.
    const again = openSqliteStore(db, migrations());
    const { id } = JSON.parse(done.body) as { id: string };
    expect(await again.exists(id, Date.now())).toBe(true);
    await again.close();
  });

  it("exits 3 for a second server on the same database and 0 on SIGINT for the first", async () => {
    const db = join(tmp.path, "data", "two.db");
    const first = await start(db);
    const second = runServer(bundle, env(db));
    await expectExit(second, 3);
    expect(second.stderr()).toMatch(/locked/i);
    expect(second.stdout()).toBe("");
    first.child.process.kill("SIGINT");
    await expectExit(first.child, 0);
  });

  it("closes lingering connections after the grace period and still exits 0", async () => {
    const db = join(tmp.path, "data", "slow.db");
    const { child, port } = await start(db);
    const hanging = new Promise<void>((resolve) => {
      const req = httpRequest({ host: "127.0.0.1", port, method: "POST", path: "/api/secrets?ttl=3600", headers: { "Content-Type": "application/octet-stream", "Content-Length": "200" } });
      req.on("error", () => resolve());
      req.on("close", () => resolve());
      req.write(Buffer.alloc(10)); // never finished
    });
    await new Promise((r) => setTimeout(r, 150));
    const t0 = Date.now();
    child.process.kill("SIGTERM");
    await expectExit(child, 0);
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(Date.now() - t0).toBeGreaterThan(7_000);
    await hanging;
  }, 50_000);

  it("a second signal exits 1 at once", async () => {
    const db = join(tmp.path, "data", "twice.db");
    const { child, port } = await start(db);
    const req = httpRequest({ host: "127.0.0.1", port, method: "POST", path: "/api/secrets?ttl=3600", headers: { "Content-Type": "application/octet-stream", "Content-Length": "200" } });
    req.on("error", () => {});
    req.write(Buffer.alloc(10));
    await new Promise((r) => setTimeout(r, 150));
    child.process.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    child.process.kill("SIGTERM");
    await expectExit(child, 1);
    req.destroy();
  });

  it("keeps working for limits: an over-limit upload through the real process gets 413", async () => {
    const db = join(tmp.path, "data", "big.db");
    const { child, port } = await start(db);
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, method: "POST", path: "/api/secrets?ttl=3600", headers: { "Content-Type": "application/octet-stream" } });
      req.on("response", (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode!));
      });
      req.on("error", reject);
      const chunk = Buffer.alloc(1024);
      let sent = 0;
      const pump = () => {
        while (sent < MAX_BLOB_BYTES * 20) {
          sent += chunk.length;
          if (!req.write(chunk)) return void req.once("drain", pump);
        }
        req.end();
      };
      pump();
    });
    expect(status).toBe(413);
    child.process.kill("SIGTERM");
    await expectExit(child, 0);
  });
});
