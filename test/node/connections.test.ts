import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../../server/config";
import { startServer, type Running } from "../../server/start";
import { makeDist, MIGRATIONS_DIR, tempDir } from "./helpers";

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
  });

  const open = (port: number): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const s = connect(port, "127.0.0.1", () => resolve(s));
      s.once("error", reject);
      sockets.push(s);
    });

  const closedByServer = (s: Socket): Promise<boolean> =>
    new Promise((resolve) => {
      s.once("close", () => resolve(true));
      setTimeout(() => resolve(false), 600);
    });

  it("drops connections beyond ONETIME_MAX_CONNECTIONS and accepts again once one closes", async () => {
    running = await startServer(config(2));
    const a = await open(running.port);
    const b = await open(running.port);
    await new Promise((r) => setTimeout(r, 50));
    const c = await open(running.port);
    expect(await closedByServer(c)).toBe(true);
    expect(a.destroyed).toBe(false);
    expect(b.destroyed).toBe(false);

    a.destroy();
    await new Promise((r) => setTimeout(r, 100));
    const d = await open(running.port);
    d.write("GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    const reply = await new Promise<string>((resolve) => {
      let text = "";
      d.on("data", (chunk) => (text += chunk));
      d.once("close", () => resolve(text));
    });
    expect(reply).toMatch(/^HTTP\/1\.1 200/);
  });
});
