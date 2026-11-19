import { describe, expect, it } from "vitest";
import { decodeInput, EXIT, parseArgs, parseLinkInput, parseTtl, resolveServer, run, stripOneNewline, UsageError } from "../cli/core";
import { makeIo, routerFetch, type Recorded } from "./cli-helpers";

const ID = "A".repeat(22);
const KEY = "B".repeat(43);

describe("parseTtl", () => {
  it("accepts presets and seconds", () => {
    expect(parseTtl("1h")).toBe(3600);
    expect(parseTtl("1d")).toBe(86400);
    expect(parseTtl("7d")).toBe(604800);
    expect(parseTtl("120")).toBe(120);
  });
  it("rejects anything else", () => {
    for (const bad of ["", "2d", "1w", "-5", "1.5", "59", "604801", "abc", "1h "]) {
      expect(() => parseTtl(bad), bad).toThrow(UsageError);
    }
  });
});

describe("stripOneNewline", () => {
  it("strips exactly one trailing newline", () => {
    expect(stripOneNewline("a\n")).toBe("a");
    expect(stripOneNewline("a\r\n")).toBe("a");
    expect(stripOneNewline("a\n\n")).toBe("a\n");
    expect(stripOneNewline("a")).toBe("a");
    expect(stripOneNewline("line1\nline2\n")).toBe("line1\nline2");
  });
});

describe("resolveServer", () => {
  it("defaults, normalises and enforces https", () => {
    expect(resolveServer(undefined, {})).toBe("https://onetimepass.pages.dev");
    expect(resolveServer(undefined, { ONETIME_SERVER: "https://x.example/" })).toBe("https://x.example");
    expect(resolveServer("https://y.example", { ONETIME_SERVER: "https://x.example" })).toBe("https://y.example");
    expect(resolveServer("http://localhost:8788", {})).toBe("http://localhost:8788");
    expect(resolveServer("http://127.0.0.1:1", {})).toBe("http://127.0.0.1:1");
  });
  it("rejects http elsewhere and junk", () => {
    expect(() => resolveServer("http://example.com", {})).toThrow(UsageError);
    expect(() => resolveServer("ftp://example.com", {})).toThrow(UsageError);
    expect(() => resolveServer("nonsense", {})).toThrow(UsageError);
  });
});

describe("injectable default server", () => {
  it("resolveServer uses the injected default only when nothing else is given", () => {
    expect(resolveServer(undefined, {}, "https://my.host")).toBe("https://my.host");
    expect(resolveServer(undefined, { ONETIME_SERVER: "https://x.example" }, "https://my.host")).toBe("https://x.example");
    expect(resolveServer("https://y.example", {}, "https://my.host")).toBe("https://y.example");
  });
  it("an injected default still has to be https or localhost", () => {
    expect(() => resolveServer(undefined, {}, "http://example.com")).toThrow(UsageError);
  });
  it("run() sends gen links to Io.defaultServer", async () => {
    const rec: Recorded = { urls: [], methods: [] };
    const io = { ...makeIo({ fetch: routerFetch(rec) }), defaultServer: "https://my.host" };
    expect(await run(["gen"], io)).toBe(EXIT.ok);
    expect(rec.urls[0]).toMatch(/^https:\/\/my\.host\/api\/secrets/);
  });
});

describe("parseLinkInput", () => {
  it("parses full links and id.key", () => {
    expect(parseLinkInput(`https://a.example/#${ID}.${KEY}`, "https://d.example")).toEqual({
      origin: "https://a.example",
      id: ID,
      key: KEY,
    });
    expect(parseLinkInput(`  ${ID}.${KEY}\n`, "https://d.example")).toEqual({ origin: "https://d.example", id: ID, key: KEY });
  });
  it("flags damaged links", () => {
    for (const bad of [`https://a.example/#${ID}`, `https://a.example/`, `${ID}`, `${ID}.short`, "", `https://a.example/#${ID}.${KEY}.x`]) {
      expect(parseLinkInput(bad, "https://d.example"), bad).toBe("invalid");
    }
  });
  it("applies the https rule to the link origin", () => {
    expect(parseLinkInput(`http://evil.example/#${ID}.${KEY}`, "https://d.example")).toBe("invalid");
  });
  it("accepts a local http link only when the same server was set explicitly", () => {
    const link = `http://localhost:8788/#${ID}.${KEY}`;
    expect(parseLinkInput(link, "https://d.example", "http://localhost:8788")).toEqual({
      origin: "http://localhost:8788",
      id: ID,
      key: KEY,
    });
    expect(() => parseLinkInput(link, "https://d.example")).toThrow(UsageError);
    expect(() => parseLinkInput(link, "https://d.example", "http://localhost:9999")).toThrow(UsageError);
    expect(() => parseLinkInput(link, "https://d.example", "https://d.example")).toThrow(UsageError);
  });
});

describe("parseArgs", () => {
  it("parses send", () => {
    expect(parseArgs(["send"])).toMatchObject({ kind: "send", ttl: 86400 });
    expect(parseArgs(["send", "--ttl", "1h", "--server=https://s.example"])).toMatchObject({
      kind: "send",
      ttl: 3600,
      server: "https://s.example",
    });
  });
  it("refuses a secret on the command line", () => {
    expect(() => parseArgs(["send", "hunter2"])).toThrow(/command line|history/);
  });
  it("parses gen", () => {
    expect(parseArgs(["gen"])).toMatchObject({ kind: "gen", type: "password", symbols: true, lookalikes: true });
    expect(parseArgs(["gen", "--type", "hex", "--length", "16", "--show", "--ttl", "7d"])).toMatchObject({
      type: "hex",
      length: 16,
      show: true,
      ttl: 604800,
    });
    expect(parseArgs(["gen", "--no-symbols", "--no-lookalikes"])).toMatchObject({ symbols: false, lookalikes: false });
    expect(parseArgs(["gen", "--print-only"])).toMatchObject({ printOnly: true });
  });
  it("validates gen options", () => {
    expect(() => parseArgs(["gen", "--type", "rot13"])).toThrow(UsageError);
    expect(() => parseArgs(["gen", "--length", "7"])).toThrow(UsageError);
    expect(() => parseArgs(["gen", "--length", "129"])).toThrow(UsageError);
    expect(() => parseArgs(["gen", "--type", "hex", "--length", "15"])).toThrow(UsageError);
    expect(() => parseArgs(["gen", "--type", "hex", "--length", "65"])).toThrow(UsageError);
    expect(() => parseArgs(["gen", "--length", "abc"])).toThrow(UsageError);
    expect(() => parseArgs(["gen", "--type", "uuid", "--length", "20"])).toThrow(UsageError);
    expect(() => parseArgs(["gen", "--type", "hex", "--no-symbols"])).toThrow(UsageError);
    expect(() => parseArgs(["gen", "--print-only", "--show"])).toThrow(UsageError);
  });
  it("parses get and status", () => {
    expect(parseArgs(["get", "L"])).toMatchObject({ kind: "get", link: "L" });
    expect(parseArgs(["get"])).toEqual({ kind: "get" });
    expect(parseArgs(["get", "-"])).toMatchObject({ kind: "get", link: "-" });
    expect(parseArgs(["status", "L", "--server", "https://s.example"])).toMatchObject({ kind: "status", link: "L" });
    expect(() => parseArgs(["get", "a", "b"])).toThrow(UsageError);
  });
  it("handles help and version", () => {
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseArgs([])).toEqual({ kind: "help" });
    expect(parseArgs(["send", "-h"])).toEqual({ kind: "help", topic: "send" });
    expect(parseArgs(["help", "gen"])).toEqual({ kind: "help", topic: "gen" });
    expect(parseArgs(["--version"])).toEqual({ kind: "version" });
  });
  it("rejects unknown things and missing values", () => {
    expect(() => parseArgs(["frobnicate"])).toThrow(UsageError);
    expect(() => parseArgs(["send", "--nope"])).toThrow(UsageError);
    expect(() => parseArgs(["send", "--ttl"])).toThrow(UsageError);
    expect(() => parseArgs(["status", "--ttl", "1h"])).toThrow(UsageError);
    expect(() => parseArgs(["send", "--show"])).toThrow(UsageError);
  });
});

describe("run", () => {
  it("prints help and version", async () => {
    const io = makeIo();
    expect(await run(["--help"], io)).toBe(EXIT.ok);
    expect(io.out).toContain("onetime send");
    expect(io.out).toContain("gen");
    const v = makeIo();
    expect(await run(["--version"], v)).toBe(EXIT.ok);
    expect(v.out).toBe("9.9.9\n");
    const h = makeIo();
    expect(await run(["get", "--help"], h)).toBe(EXIT.ok);
    expect(h.out).toContain("onetime get");
  });
  it("usage errors exit 2 on stderr, nothing on stdout", async () => {
    const io = makeIo();
    expect(await run(["send", "hunter2"], io)).toBe(EXIT.usage);
    expect(io.out).toBe("");
    expect(io.err).not.toContain("hunter2");
    expect(io.err).toMatch(/history/);
  });
  it("send rejects an empty or oversized secret before any request", async () => {
    expect(await run(["send"], makeIo({ stdin: "\n" }))).toBe(EXIT.usage);
    const big = makeIo({ stdin: "x".repeat(16 * 1024 + 1) });
    expect(await run(["send"], big)).toBe(EXIT.usage);
    expect(big.err).not.toContain("xxxxxxxx");
  });
  it("a damaged link never contacts the server and leaks nothing", async () => {
    for (const cmd of ["get", "status"]) {
      const io = makeIo();
      expect(await run([cmd, `${ID}.tooshort`], io)).toBe(EXIT.badLink);
      expect(io.err).not.toContain(ID);
      expect(io.err).not.toContain("tooshort");
    }
    const noArg = makeIo({ stdin: "garbage\n" });
    expect(await run(["get"], noArg)).toBe(EXIT.badLink);
  });
  it("network failure exits 5 without the key", async () => {
    const io = makeIo({
      fetch: (async () => {
        throw new TypeError("boom");
      }) as typeof fetch,
    });
    expect(await run(["get", `${ID}.${KEY}`], io)).toBe(EXIT.network);
    expect(io.err + io.out).not.toContain(KEY);
  });
  it("server errors exit 5", async () => {
    const io = makeIo({ fetch: (async () => new Response("no", { status: 503 })) as typeof fetch });
    expect(await run(["status", `${ID}.${KEY}`], io)).toBe(EXIT.network);
  });
  it("gen --print-only prints a secret and contacts nobody", async () => {
    const io = makeIo();
    expect(await run(["gen", "--print-only", "--type", "hex", "--length", "16"], io)).toBe(EXIT.ok);
    expect(io.out).toMatch(/^[0-9a-f]{32}\n$/);
  });
  it("get warns about shell history when the link is an argument", async () => {
    const io = makeIo({ fetch: (async () => new Response("{}", { status: 404 })) as typeof fetch });
    await run(["get", `${ID}.${KEY}`], io);
    expect(io.err).toMatch(/history/);
    expect(io.err).not.toContain(KEY);
  });
  it("strips one CRLF from a piped secret and prints a double-quoted hint", async () => {
    const posted: Uint8Array[] = [];
    const io = makeIo({
      stdin: "pw\r\n",
      fetch: (async (_url: string, init: RequestInit) => {
        posted.push(init.body as Uint8Array);
        return new Response(JSON.stringify({ id: ID }), { status: 201 });
      }) as unknown as typeof fetch,
    });
    expect(await run(["send", "--server", "https://s.example"], io)).toBe(EXIT.ok);
    expect(io.out).toMatch(/^https:\/\/s\.example\/#/);
    expect(io.err).toContain("onetime get -");
    expect(io.err).not.toContain(io.out.trim());
    expect(io.err).not.toContain("#");
    // 2 bytes of plaintext + 12 IV + 16 tag: no CR or LF was encrypted.
    expect(posted[0]!.byteLength).toBe(2 + 28);
  });
  it("never puts the link or key in the send hint", async () => {
    const io = makeIo({
      stdin: "pw",
      fetch: (async () => new Response(JSON.stringify({ id: ID }), { status: 201 })) as unknown as typeof fetch,
    });
    await run(["send", "--server", "https://s.example"], io);
    const key = io.out.trim().split(".")[1]!;
    expect(io.err).not.toContain(key);
    expect(io.err).not.toContain(ID);
  });
  it("refuses a local http link unless --server names it", async () => {
    const link = `http://127.0.0.1:1/#${ID}.${KEY}`;
    const a = makeIo();
    expect(await run(["get", link], a)).toBe(EXIT.usage);
    const b = makeIo();
    expect(await run(["status", link], b)).toBe(EXIT.usage);
    expect(a.err + b.err).not.toContain(KEY);
  });
});

describe("decodeInput", () => {
  const enc = (t: string) => new TextEncoder().encode(t);
  it("decodes UTF-8 and strips BOMs", () => {
    expect(decodeInput(enc("héllo"))).toBe("héllo");
    expect(decodeInput(new Uint8Array([0xef, 0xbb, 0xbf, ...enc("hi")]))).toBe("hi");
    const utf16 = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0xe9, 0x00, 0x0d, 0x00, 0x0a, 0x00]);
    expect(decodeInput(utf16)).toBe("hé\r\n");
  });
  it("rejects invalid UTF-8 and odd UTF-16", () => {
    expect(() => decodeInput(new Uint8Array([0xff, 0x41]))).toThrow(UsageError);
    expect(() => decodeInput(new Uint8Array([0xff, 0xfe, 0x41]))).toThrow(UsageError);
  });
});

describe("hostile server responses", () => {
  const link = `${ID}.${KEY}`;
  const stream = (chunks: number, size: number, headers: Record<string, string> = {}) => {
    let sent = 0;
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (sent++ >= chunks) return controller.close();
          controller.enqueue(new Uint8Array(size));
        },
      }),
      { status: 200, headers },
    );
  };
  const getWith = (response: () => Response) =>
    run(["get", link, "--server", "https://s.example"], makeIo({ fetch: (async () => response()) as unknown as typeof fetch }));

  it("rejects an oversized reveal body (Content-Length and counted stream)", async () => {
    expect(await getWith(() => new Response("x", { headers: { "Content-Length": "99999" } }))).toBe(EXIT.network);
    let pulled = 0;
    const res = () =>
      new Response(
        new ReadableStream({
          pull(c) {
            pulled++;
            c.enqueue(new Uint8Array(8192));
          },
        }),
      );
    expect(await getWith(res)).toBe(EXIT.network);
    expect(pulled).toBeLessThan(10);
  });
  it("rejects oversized or non-JSON create answers", async () => {
    const send = (r: () => Response) =>
      run(["send", "--server", "https://s.example"], makeIo({ stdin: "x", fetch: (async () => r()) as unknown as typeof fetch }));
    expect(await send(() => stream(100, 1024))).toBe(EXIT.network);
    expect(await send(() => new Response("<html>", { status: 201 }))).toBe(EXIT.network);
  });
  it("tolerates oversized error bodies", async () => {
    const io = makeIo({ fetch: (async () => stream(1000, 1024)) as unknown as typeof fetch });
    const r = new Response(new Uint8Array(100000), { status: 500 });
    io.fetch = (async () => r) as unknown as typeof fetch;
    expect(await run(["status", link, "--server", "https://s.example"], io)).toBe(EXIT.network);
  });
  it("rejects a server-supplied id that is not a plain id", async () => {
    for (const id of [42, "\u001b[31mred", "short"]) {
      const io = makeIo({
        stdin: "x",
        fetch: (async () => new Response(JSON.stringify({ id }), { status: 201 })) as unknown as typeof fetch,
      });
      expect(await run(["send", "--server", "https://s.example"], io)).toBe(EXIT.network);
      expect(io.out + io.err).not.toContain("\u001b");
    }
  });
  it("does not follow redirects", async () => {
    let calls = 0;
    const io = makeIo({
      fetch: (async () => {
        calls++;
        return new Response(null, { status: 302, headers: { Location: "https://evil.example/" } });
      }) as unknown as typeof fetch,
    });
    expect(await run(["get", link, "--server", "https://s.example"], io)).toBe(EXIT.network);
    expect(calls).toBe(1);
  });
});

describe("stdin, output and internal errors", () => {
  it("rejects oversized and non-UTF-8 stdin", async () => {
    expect(await run(["send"], makeIo({ stdin: new Uint8Array(16 * 1024 * 4 + 10).fill(65) }))).toBe(EXIT.usage);
    const io = makeIo({ stdin: new Uint8Array([0xff, 0xfe, 0xfd]) });
    expect(await run(["send"], io)).toBe(EXIT.usage);
    expect(io.err).toMatch(/UTF-8/);
  });
  it("exits 5 when writing the secret fails", async () => {
    const { blob, key } = await (await import("../src/web/crypto")).encryptSecret("s");
    const io = makeIo({
      writeStdout: () => {
        throw new Error("EPIPE");
      },
      fetch: (async () => new Response(blob)) as unknown as typeof fetch,
    });
    expect(await run(["get", `${ID}.${key}`, "--server", "https://s.example"], io)).toBe(EXIT.network);
    expect(io.err).toMatch(/write/i);
  });
  it("gives unexpected errors their own exit code", async () => {
    const io = makeIo({
      stdin: "x",
      fetch: (async () => {
        throw new RangeError("weird");
      }) as unknown as typeof fetch,
    });
    // fetch failures are network errors; a crash inside the core is internal
    io.stdin.readBytes = async () => {
      throw new Error("boom");
    };
    expect(await run(["send"], io)).toBe(EXIT.internal);
    expect(EXIT.internal).toBe(70);
  });
});
