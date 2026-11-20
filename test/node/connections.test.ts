import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../../server/config";
import { startServer, type Running } from "../../server/start";
import { makeDist, MIGRATIONS_DIR, tempDir, waitFor } from "./helpers";

describe("connection limit", () => {
  let tmp: ReturnType<typeof tempDir>;
  let running: Running | undefined;
  const sockets: Socket[] = [];
  beforeEach(() => void (tmp = tempDir()));
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.destroy();
    await running?.shutdown(500);
    running = undefined;
    tmp.remove();
  });

  const config = (maxConnections: number): Config => ({
    host: "127.0.0.1",
    port: 0,
    dbPath: join(tmp.path, "c.db"),
    distDir: makeDist(tmp.path),
    migrationsDir: MIGRATIONS_DIR,
    maxStored: 10,
    maxConnections,
    maxStoredBytes: 400_000_000,
    maxLargeBytes: 200_000_000,
    maxFileBytes: 262_144,
    maxFileTtl: 3600,
    maxUploads: 16,
  });

  const open = (port: number): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const s = connect(port, "127.0.0.1", () => resolve(s));
      s.once("error", reject);
      sockets.push(s);
    });

  const closedByServer = (s: Socket) => waitFor(() => s.destroyed, 5000, "the server to close the extra connection");

  it("drops connections beyond ONETIME_MAX_CONNECTIONS and accepts again once one closes", async () => {
    running = await startServer(config(2));
    const a = await open(running.port);
    const b = await open(running.port);
    await waitFor(() => a.readyState === "open" && b.readyState === "open", 5000, "both sockets open");
    const c = await open(running.port);
    await closedByServer(c);
    expect(a.destroyed).toBe(false);
    expect(b.destroyed).toBe(false);

    a.destroy();
    // The server notices the freed slot a moment later: retry, bounded, until a new connection is served.
    const port = running.port;
    const request = async (): Promise<string> => {
      const d = await open(port);
      d.write("GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
      return new Promise<string>((resolve) => {
        let text = "";
        d.on("data", (chunk) => (text += chunk));
        d.once("close", () => resolve(text));
      });
    };
    let reply = "";
    const end = Date.now() + 5000;
    while (!reply.startsWith("HTTP/1.1 200") && Date.now() < end) {
      reply = await request();
      if (!reply) await new Promise((r) => setTimeout(r, 20));
    }
    expect(reply).toMatch(/^HTTP\/1\.1 200/);
  });
});
