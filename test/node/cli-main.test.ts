import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT, run, type Io } from "../../cli/core";
import { readFileBytes, removeFile, statPath, writeFileExclusive } from "../../cli/fs-io";
import { openSqliteStore } from "../../server/store-sqlite";
import { handle } from "../../src/worker/index";
import { createCodec } from "../../src/web/crypto";
import { buildLink } from "../../src/web/link";
import { migrations, tempDir } from "./helpers";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("CLI entry point", () => {
  it("never sets the test-only hooks (pbkdf2Iterations, writeFormat, writeFiles)", () => {
    const main = read("cli/main.ts");
    expect(main).not.toMatch(/pbkdf2Iterations/);
    expect(main).not.toMatch(/writeFormat/);
    expect(main).not.toMatch(/writeFiles/);
  });

  it("provides readFile and reads at most max + 1 bytes of it", () => {
    const main = read("cli/main.ts");
    expect(main).toMatch(/readFile/);
    expect(main).toMatch(/max \+ 1/);
  });

  it("is version 0.4.0 (it asks the server for its file limits)", () => {
    expect(JSON.parse(read("package.json")).version).toBe("0.4.0");
  });
});

describe("CLI file system access with a real directory", () => {
  const bytes = (n: number, v = 5) => new Uint8Array(n).fill(v);

  it("statPath tells dir, file and missing apart, and counts any symlink that exists as taken", async () => {
    const dir = tempDir();
    mkdirSync(join(dir.path, "d"));
    writeFileSync(join(dir.path, "f"), "x");
    symlinkSync(join(dir.path, "f"), join(dir.path, "link-to-file"));
    symlinkSync(join(dir.path, "d"), join(dir.path, "link-to-dir"));
    symlinkSync(join(dir.path, "nowhere"), join(dir.path, "dangling"));
    expect(await statPath(join(dir.path, "d"))).toBe("dir");
    expect(await statPath(join(dir.path, "f"))).toBe("file");
    expect(await statPath(join(dir.path, "missing"))).toBe("missing");
    expect(await statPath(join(dir.path, "link-to-file"))).toBe("file");
    expect(await statPath(join(dir.path, "link-to-dir"))).toBe("dir");
    expect(await statPath(join(dir.path, "dangling"))).toBe("file");
  });

  it("writeFileExclusive creates the file with mode 0600 and the exact bytes", async () => {
    const dir = tempDir();
    const old = process.umask(0);
    try {
      const path = join(dir.path, "new.bin");
      await writeFileExclusive(path, bytes(300_000, 9));
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(Buffer.from(readFileSync(path)).equals(Buffer.from(bytes(300_000, 9)))).toBe(true);
    } finally {
      process.umask(old);
    }
  });

  it("writeFileExclusive never overwrites, and never writes through a symlink, dangling or not", async () => {
    const dir = tempDir();
    const victim = join(dir.path, "victim");
    writeFileSync(victim, "precious");
    writeFileSync(join(dir.path, "exists"), "keep");
    symlinkSync(victim, join(dir.path, "link"));
    symlinkSync(join(dir.path, "not-yet"), join(dir.path, "dangling"));
    for (const name of ["exists", "link", "dangling"]) {
      await expect(writeFileExclusive(join(dir.path, name), bytes(10))).rejects.toMatchObject({ code: "EEXIST" });
    }
    expect(readFileSync(victim, "utf8")).toBe("precious");
    expect(readFileSync(join(dir.path, "exists"), "utf8")).toBe("keep");
    expect(existsSync(join(dir.path, "not-yet"))).toBe(false);
  });

  it("removeFile deletes, readFileBytes reads at most max + 1 bytes", async () => {
    const dir = tempDir();
    const path = join(dir.path, "r");
    writeFileSync(path, bytes(50));
    expect((await readFileBytes(path, 10)).length).toBe(11);
    expect((await readFileBytes(path, 100)).length).toBe(50);
    await removeFile(path);
    expect(existsSync(path)).toBe(false);
    await expect(readFileBytes(path, 10)).rejects.toThrow();
  });

  /** The real core with real file access against the real router and a SQLite store; returns what the CLI printed. */
  async function session() {
    const dir = tempDir();
    const store = openSqliteStore(join(dir.path, "s.db"), migrations());
    const codec = createCodec({ writeFormat: 2, writeFiles: true, pbkdf2Iterations: 1000 });
    const posts: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === "POST" && request.url.endsWith("/reveal")) posts.push(request.url);
      const pending: Promise<unknown>[] = [];
      const response = await handle(request, store, { waitUntil: (p) => void pending.push(p) });
      await Promise.all(pending);
      return response;
    }) as typeof fetch;
    const upload = async (name: string, content: Uint8Array): Promise<string> => {
      const made = await codec.encryptFile({ name, type: "", bytes: content });
      const response = await fetchImpl("https://onetime.test/api/secrets?ttl=3600", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: made.blob,
      });
      const { id } = (await response.json()) as { id: string };
      return buildLink("https://onetime.test", { id, key: made.key, format: 2, passphrase: false, file: true });
    };
    const get = async (link: string, args: string[]) => {
      let err = "";
      const io: Io = {
        fetch: fetchImpl,
        env: { ONETIME_SERVER: "https://onetime.test" },
        version: "test",
        pbkdf2Iterations: 1000,
        stdin: { isTTY: true, readBytes: async () => new Uint8Array() },
        promptHidden: async () => "",
        readFile: readFileBytes,
        stat: statPath,
        writeFileExclusive,
        removeFile,
        stdout: { isTTY: false, write: () => {}, writeBytes: () => {} },
        stderr: { write: (t) => void (err += t) },
      };
      return { code: await run(["get", link, ...args], io), err: () => err };
    };
    return { dir, upload, get, posts, close: () => store.close() };
  }

  it("get -o DIR saves under the safe name with mode 0600, even for a hostile name", async () => {
    const s = await session();
    try {
      const out = join(s.dir.path, "out");
      mkdirSync(out);
      const content = bytes(70_000, 3);
      const link = await s.upload("..\\..\\evil\u202e.txt/../../etc/passwd", content);
      const { code, err } = await s.get(link, ["-o", out]);
      expect(code, err()).toBe(EXIT.ok);
      expect(readdirSync(out)).toEqual(["passwd"]);
      expect(statSync(join(out, "passwd")).mode & 0o777).toBe(0o600);
      expect(Buffer.from(readFileSync(join(out, "passwd"))).equals(Buffer.from(content))).toBe(true);
    } finally {
      await s.close();
    }
  });

  it("get -o DIR with a symlink in the way takes the next free name and leaves the link target alone", async () => {
    const s = await session();
    try {
      const out = join(s.dir.path, "out");
      mkdirSync(out);
      const victim = join(s.dir.path, "victim.txt");
      writeFileSync(victim, "precious");
      symlinkSync(victim, join(out, "a.txt"));
      const link = await s.upload("a.txt", bytes(10, 1));
      const { code, err } = await s.get(link, ["-o", out]);
      expect(code, err()).toBe(EXIT.ok);
      expect(readFileSync(victim, "utf8")).toBe("precious");
      expect(Buffer.from(readFileSync(join(out, "a (1).txt"))).equals(Buffer.from(bytes(10, 1)))).toBe(true);
    } finally {
      await s.close();
    }
  });

  it("get -o PATH where PATH is a symlink (dangling or not) is refused before the reveal request", async () => {
    const s = await session();
    try {
      const victim = join(s.dir.path, "victim.txt");
      writeFileSync(victim, "precious");
      symlinkSync(victim, join(s.dir.path, "link"));
      symlinkSync(join(s.dir.path, "gone"), join(s.dir.path, "dangling"));
      const link = await s.upload("a.txt", bytes(10, 1));
      for (const name of ["link", "dangling"]) {
        const { code, err } = await s.get(link, ["-o", join(s.dir.path, name)]);
        expect(code, err()).toBe(EXIT.usage);
        expect(err()).toContain("already exists; nothing was opened");
      }
      expect(s.posts).toEqual([]);
      expect(readFileSync(victim, "utf8")).toBe("precious");
      expect(existsSync(join(s.dir.path, "gone"))).toBe(false);
    } finally {
      await s.close();
    }
  });
});
