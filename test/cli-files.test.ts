import { describe, expect, it } from "vitest";
import { EXIT, parseArgs, parseLinkInput, run, UsageError } from "../cli/core";
import { MAX_FILE_BYTES } from "../src/shared/limits";
import { createCodec } from "../src/web/crypto";
import { buildLink } from "../src/web/link";
import { makeIo, routerFetch, SERVER, type Recorded } from "./cli-helpers";

// workerd refuses the real 600,000 PBKDF2 iterations; the real count is proven in test/node/crypto-files.test.ts.
const codec = createCodec({ writeFormat: 2, writeFiles: true, pbkdf2Iterations: 1000 });
const PASS = "correct horse battery";
const same = (a: Uint8Array | undefined, b: Uint8Array) => a !== undefined && Buffer.from(a).equals(Buffer.from(b));

function setup(extra: Parameters<typeof makeIo>[0] = {}) {
  const rec: Recorded = { urls: [], methods: [] };
  return { rec, opts: { fetch: routerFetch(rec), env: { ONETIME_SERVER: SERVER }, ...extra } };
}

/** Puts a file blob on the server directly and returns its link. */
async function upload(file: { name: string; type?: string; bytes: Uint8Array }, passphrase?: string): Promise<string> {
  const made = await codec.encryptFile({ name: file.name, type: file.type ?? "", bytes: file.bytes }, passphrase);
  const response = await routerFetch()(`${SERVER}/api/secrets?ttl=3600`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: made.blob,
  });
  expect(response.status).toBe(201);
  const { id } = (await response.json()) as { id: string };
  return buildLink(SERVER, { id, key: made.key, format: 2, passphrase: made.passphrase, file: true });
}

const status = async (link: string) => (await routerFetch()(`${SERVER}/api/secrets/${new URL(link).hash.split(".")[1]}`)).status;

describe("parseArgs for files", () => {
  it("accepts --file and --name on send, and -o / --output on get", () => {
    expect(parseArgs(["send", "--file", "a.txt"])).toMatchObject({ kind: "send", file: "a.txt" });
    expect(parseArgs(["send", "--file=-", "--name", "x.bin"])).toMatchObject({ kind: "send", file: "-", name: "x.bin" });
    expect(parseArgs(["get", "L", "-o", "out.bin"])).toMatchObject({ kind: "get", link: "L", output: "out.bin" });
    expect(parseArgs(["get", "L", "--output=dir"])).toMatchObject({ kind: "get", output: "dir" });
    expect(parseArgs(["send"])).not.toHaveProperty("file");
  });
  it("refuses --name without --file, -o without a value, and -o on other commands", () => {
    expect(() => parseArgs(["send", "--name", "x"])).toThrow(UsageError);
    expect(() => parseArgs(["get", "L", "-o"])).toThrow(UsageError);
    expect(() => parseArgs(["status", "L", "-o", "x"])).toThrow(UsageError);
    expect(() => parseArgs(["gen", "--file", "x"])).toThrow(UsageError);
  });
});

describe("parseLinkInput with file links", () => {
  const ID = "A".repeat(22);
  const KEY = "B".repeat(43);
  it("parses 2f and 2fp", () => {
    expect(parseLinkInput(`https://a.example/#2f.${ID}.${KEY}`, "https://d.example")).toMatchObject({ format: 2, passphrase: false, file: true });
    expect(parseLinkInput(`2fp.${ID}.${KEY}`, "https://d.example")).toMatchObject({ format: 2, passphrase: true, file: true });
  });
  it("calls the 0.2.0 grammar's view of them damaged (so CLI 0.2.0 exits 3 before any request)", () => {
    const oldPattern = /^2p?$/; // CLI 0.2.0 FORMAT_PATTERN
    expect(oldPattern.test("2f")).toBe(false);
    expect(oldPattern.test("2fp")).toBe(false);
  });
});

describe("send --file", () => {
  it("a build with WRITE_FILES off (test hook) refuses: exit 2, nothing read, nothing sent", async () => {
    const { rec, opts } = setup({ writeFiles: false, files: { "a.txt": "hello" } });
    const io = makeIo({ ...opts });
    expect(await run(["send", "--file", "a.txt"], io)).toBe(EXIT.usage);
    expect(io.err).toContain("Sending files is not available yet.");
    expect(rec.methods).toEqual([]);
    expect(io.out).toBe("");
  });

  it("encrypts a file under a 2f link, prints only the link and hints on stderr without link or key", async () => {
    const { rec, opts } = setup({ writeFiles: true, files: { "/home/u/docs/report.pdf": new Uint8Array([1, 2, 3, 4, 5]) } });
    const io = makeIo(opts);
    expect(await run(["send", "--file", "/home/u/docs/report.pdf"], io), io.err).toBe(EXIT.ok);
    expect(io.out).toMatch(/^https:\/\/onetime\.test\/#2f\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\n$/);
    expect(io.err).toContain("File: report.pdf (5 bytes). Files last at most 1 hour.");
    expect(io.err).toContain("Expires in 1 hour if not opened.");
    const key = io.out.trim().split(".")[2]!;
    expect(io.err).not.toContain(key);
    expect(io.err).not.toContain("#2f");
    expect(rec.methods).toEqual(["GET", "POST"]); // the limits first, then the upload
    expect(rec.urls[0]).toBe(`${SERVER}/api/limits`);
    // The server holds a file blob in a file bucket and nothing readable.
    const parsed = parseLinkInput(io.out.trim(), SERVER);
    if (parsed === "invalid") throw new Error("bad link");
    const blob = new Uint8Array(await (await routerFetch()(`${SERVER}/api/secrets/${parsed.id}/reveal`, { method: "POST" })).arrayBuffer());
    expect(blob.length).toBe(1054);
    expect(blob[1]).toBe(2);
    const opened = await codec.openPayload(blob, await codec.deriveKey(parsed), parsed);
    expect(opened).toMatchObject({ kind: "file", name: "report.pdf", type: "" });
    expect(opened.kind === "file" && same(opened.bytes, new Uint8Array([1, 2, 3, 4, 5]))).toBe(true);
  });

  it("with --name stores that name, sanitised", async () => {
    const { opts } = setup({ writeFiles: true, files: { "x.bin": "abc" } });
    const io = makeIo(opts);
    expect(await run(["send", "--file", "x.bin", "--name", "../../etc/pass‮wd"], io), io.err).toBe(EXIT.ok);
    expect(io.err).toContain("File: passwd (3 bytes)");
  });

  it("reads --file - as raw bytes from a pipe: no UTF-8 check, no newline stripping", async () => {
    const raw = new Uint8Array([0xff, 0xfe, 0x00, 0x0d, 0x0a, 0x80, 0x0a]);
    const { opts } = setup({ writeFiles: true, stdin: raw });
    const io = makeIo(opts);
    expect(await run(["send", "--file", "-", "--name", "blob.dat"], io), io.err).toBe(EXIT.ok);
    const link = io.out.trim();
    const get = makeIo({ ...setup().opts, stdin: null, dirs: ["/out"] });
    expect(await run(["get", link, "-o", "/out"], get), get.err).toBe(EXIT.ok);
    expect(same(get.files.get("/out/blob.dat"), raw)).toBe(true);
  });

  it("refuses --file - on a terminal", async () => {
    const { rec, opts } = setup({ writeFiles: true, stdin: null });
    const io = makeIo(opts);
    expect(await run(["send", "--file", "-"], io)).toBe(EXIT.usage);
    expect(io.err).toContain("Pipe the file in, or give a path.");
    expect(rec.methods).toEqual([]);
  });

  it("refuses --file - with --passphrase (the piped input uses the terminal) but takes --passphrase-file", async () => {
    const a = setup({ writeFiles: true, writeFormat: 2, stdin: new Uint8Array([1, 2, 3]) });
    const refused = makeIo(a.opts);
    expect(await run(["send", "--file", "-", "--passphrase"], refused)).toBe(EXIT.usage);
    expect(refused.err).toMatch(/piped/);
    expect(a.rec.methods).toEqual([]);

    const b = setup({ writeFiles: true, writeFormat: 2, stdin: new Uint8Array([1, 2, 3]), files: { "pp.txt": PASS } });
    const ok = makeIo(b.opts);
    expect(await run(["send", "--file", "-", "--passphrase-file", "pp.txt"], ok), ok.err).toBe(EXIT.ok);
    expect(ok.out).toMatch(/#2fp\./);
  });

  it("refuses an empty file and a file above the limit, before any request", async () => {
    const { rec, opts } = setup({ writeFiles: true, files: { empty: new Uint8Array(0), big: new Uint8Array(MAX_FILE_BYTES + 1) } });
    const empty = makeIo(opts);
    expect(await run(["send", "--file", "empty"], empty)).toBe(EXIT.usage);
    expect(empty.err).toContain("The file is empty.");
    const big = makeIo(opts);
    expect(await run(["send", "--file", "big"], big)).toBe(EXIT.usage);
    expect(big.err).toContain("The file is too large (limit 256.0 KB).");
    expect(rec.methods).toEqual(["GET", "GET"]); // only the limits were asked for, never an upload
  });

  it("accepts a file of exactly the limit", async () => {
    const { opts } = setup({ writeFiles: true, files: { max: new Uint8Array(MAX_FILE_BYTES).fill(1) } });
    const io = makeIo(opts);
    expect(await run(["send", "--file", "max"], io), io.err).toBe(EXIT.ok);
    expect(io.err).toContain("(256.0 KB)");
  });

  it("refuses a file that cannot be read", async () => {
    const { rec, opts } = setup({ writeFiles: true });
    const io = makeIo(opts);
    expect(await run(["send", "--file", "missing.txt"], io)).toBe(EXIT.usage);
    expect(io.err).toMatch(/Could not read the file/);
    expect(rec.methods).toEqual(["GET"]); // the limits, nothing uploaded
  });

  it("refuses --ttl above 1 hour (the hosted rule), before any upload, and accepts 1h", async () => {
    const { rec, opts } = setup({ writeFiles: true, files: { a: "x" } });
    for (const ttl of ["1d", "7d", "3601"]) {
      const io = makeIo(opts);
      expect(await run(["send", "--file", "a", "--ttl", ttl], io)).toBe(EXIT.usage);
      expect(io.err).toContain("Files can last at most 1 hour on this server.");
    }
    expect(rec.methods).toEqual(["GET", "GET", "GET"]);
    const io = makeIo(opts);
    expect(await run(["send", "--file", "a", "--ttl", "1h"], io), io.err).toBe(EXIT.ok);
  });

  it("shows --file in the help only when files can be written (on by default since deploy F2)", async () => {
    const off = makeIo({ writeFiles: false });
    await run(["send", "--help"], off);
    expect(off.out).not.toContain("--file");
    const on = makeIo();
    await run(["send", "--help"], on);
    expect(on.out).toContain("--file");
    const main = makeIo();
    await run(["--help"], main);
    expect(main.out).toContain("onetime send --file PATH|- [--name NAME] [--ttl 1h|1d]");
    expect(main.out + on.out).not.toContain("not available");
  });

  it("sends a file with the default build settings (no test hook)", async () => {
    const { opts } = setup({ files: { "a.txt": "hello" } });
    const io = makeIo(opts);
    expect(await run(["send", "--file", "a.txt"], io), io.err).toBe(EXIT.ok);
    expect(io.out).toMatch(/^https:\/\/onetime\.test\/#2f\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\n$/);
  });
});

describe("get on a file link", () => {
  it("on a terminal without -o: exit 2 and no request at all, so nothing is opened", async () => {
    const link = await upload({ name: "a.txt", bytes: new Uint8Array([1]) });
    const { rec, opts } = setup({ stdin: null, stdoutTty: true });
    const io = makeIo(opts);
    expect(await run(["get", link], io)).toBe(EXIT.usage);
    expect(io.err).toContain("This link holds a file. Save it with -o <file or directory>, or redirect the output.");
    expect(rec.methods).toEqual([]);
    expect(io.outBytes).toEqual([]);
    expect(await status(link)).toBe(200);
  });

  it("with -o naming an existing file: exit 2, no request, nothing overwritten", async () => {
    const link = await upload({ name: "a.txt", bytes: new Uint8Array([1]) });
    const { rec, opts } = setup({ files: { "/tmp/exists": "keep me" }, dirs: ["/tmp"] });
    const io = makeIo(opts);
    expect(await run(["get", link, "-o", "/tmp/exists"], io)).toBe(EXIT.usage);
    expect(io.err).toContain("/tmp/exists already exists; nothing was opened.");
    expect(rec.methods).toEqual([]);
    expect(new TextDecoder().decode(io.files.get("/tmp/exists"))).toBe("keep me");
    expect(await status(link)).toBe(200);
  });

  it("with -o in a folder that does not exist: exit 2, no request", async () => {
    const link = await upload({ name: "a.txt", bytes: new Uint8Array([1]) });
    const { rec, opts } = setup({ dirs: ["/tmp"] });
    const io = makeIo(opts);
    expect(await run(["get", link, "-o", "/nowhere/out.bin"], io)).toBe(EXIT.usage);
    expect(io.err).toMatch(/does not exist; nothing was opened/);
    expect(rec.methods).toEqual([]);
  });

  it("with -o FILE writes the exact bytes there and reports the sanitised name, size and path", async () => {
    const bytes = crypto.getRandomValues(new Uint8Array(3000));
    const link = await upload({ name: "data.bin", bytes });
    const { opts } = setup({ dirs: ["/tmp"] });
    const io = makeIo(opts);
    expect(await run(["get", link, "-o", "/tmp/mine.dat"], io), io.err).toBe(EXIT.ok);
    expect(same(io.files.get("/tmp/mine.dat"), bytes)).toBe(true);
    expect(io.err).toContain("Saved data.bin (2.9 KB) to /tmp/mine.dat.");
    expect(io.out).toBe("");
    expect(io.outBytes).toEqual([]);
  });

  it("with -o DIR writes DIR/<safe name>; a hostile name cannot leave the directory", async () => {
    const link = await upload({ name: "../../etc/passwd", bytes: new Uint8Array([7, 7]) });
    const { opts } = setup({ dirs: ["/home/u/dl"] });
    const io = makeIo(opts);
    expect(await run(["get", link, "-o", "/home/u/dl"], io), io.err).toBe(EXIT.ok);
    expect([...io.files.keys()]).toEqual(["/home/u/dl/passwd"]);
  });

  it("with -o DIR and a name that is taken: tries name (1).ext, then (2)", async () => {
    const link1 = await upload({ name: "report.pdf", bytes: new Uint8Array([1]) });
    const link2 = await upload({ name: "report.pdf", bytes: new Uint8Array([2]) });
    const { opts } = setup({ dirs: ["/d"], files: { "/d/report.pdf": "old" } });
    const a = makeIo(opts);
    expect(await run(["get", link1, "-o", "/d"], a), a.err).toBe(EXIT.ok);
    expect(same(a.files.get("/d/report (1).pdf"), new Uint8Array([1]))).toBe(true);
    expect(a.err).toContain("Saved report (1).pdf");
    const b = makeIo({ ...opts, files: { "/d/report.pdf": "old", "/d/report (1).pdf": "old" } });
    expect(await run(["get", link2, "-o", "/d"], b), b.err).toBe(EXIT.ok);
    expect(same(b.files.get("/d/report (2).pdf"), new Uint8Array([2]))).toBe(true);
    expect(new TextDecoder().decode(b.files.get("/d/report.pdf"))).toBe("old");
  });

  it("with -o DIR and 99 taken names falls back to onetime-<8 hex>.bin", async () => {
    const link = await upload({ name: "a.txt", bytes: new Uint8Array([9]) });
    const taken: Record<string, string> = { "/d/a.txt": "x" };
    for (let i = 1; i <= 99; i++) taken[`/d/a (${i}).txt`] = "x";
    const { opts } = setup({ dirs: ["/d"], files: taken });
    const io = makeIo(opts);
    expect(await run(["get", link, "-o", "/d"], io), io.err).toBe(EXIT.ok);
    const created = [...io.files.keys()].filter((p) => !(p in taken));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatch(/^\/d\/onetime-[0-9a-f]{8}\.bin$/);
  });

  it("piped stdout without -o gets only the raw bytes", async () => {
    const bytes = new Uint8Array([0, 255, 10, 13, 128]);
    const link = await upload({ name: "a.bin", bytes });
    const { opts } = setup({ stdin: null, stdoutTty: false });
    const io = makeIo(opts);
    expect(await run(["get", link], io), io.err).toBe(EXIT.ok);
    expect(io.out).toBe("");
    expect(io.outBytes).toHaveLength(1);
    expect(same(io.outBytes[0], bytes)).toBe(true);
    expect(io.files.size).toBe(0);
  });

  it("a failed write after the reveal removes the partial file and exits 5", async () => {
    const link = await upload({ name: "a.txt", bytes: new Uint8Array([1, 2, 3]) });
    const { opts } = setup({ dirs: ["/d"], failWrite: true });
    const io = makeIo(opts);
    expect(await run(["get", link, "-o", "/d"], io)).toBe(EXIT.network);
    expect(io.err).toContain("Could not write the file. It is now used up.");
    expect(io.removed).toEqual(["/d/a.txt"]);
    expect(io.files.has("/d/a.txt")).toBe(false);
    expect(await status(link)).toBe(404);
  });

  it("a file that appears between the check and the write is never overwritten and never removed", async () => {
    const link = await upload({ name: "a.txt", bytes: new Uint8Array([1]) });
    const { opts } = setup({ dirs: ["/d"], raceExists: true, files: { "/d/pre": "not mine" } });
    const io = makeIo(opts);
    expect(await run(["get", link, "-o", "/d/target"], io)).toBe(EXIT.network);
    expect(io.err).toContain("Could not write the file. It is now used up.");
    expect(io.removed).toEqual([]);
  });

  it("adds a warning for files that can run code", async () => {
    const link = await upload({ name: "setup.exe", bytes: new Uint8Array([1]) });
    const { opts } = setup({ dirs: ["/d"] });
    const io = makeIo(opts);
    expect(await run(["get", link, "-o", "/d"], io), io.err).toBe(EXIT.ok);
    expect(io.err).toContain("can run code");
    const plain = await upload({ name: "notes.txt", bytes: new Uint8Array([1]) });
    const io2 = makeIo(opts);
    await run(["get", plain, "-o", "/d"], io2);
    expect(io2.err).not.toContain("can run code");
  });

  it("opens a 2fp link with --passphrase-file, and a wrong passphrase exits 4 and writes nothing", async () => {
    const link = await upload({ name: "s.txt", bytes: new Uint8Array([4, 5]) }, PASS);
    expect(link).toMatch(/#2fp\./);
    const { opts } = setup({ stdin: null, dirs: ["/d"], files: { "good.txt": PASS, "bad.txt": "another passphrase" } });
    const bad = makeIo(opts);
    expect(await run(["get", link, "-o", "/d", "--passphrase-file", "bad.txt"], bad)).toBe(EXIT.decrypt);
    expect(bad.files.size).toBe(2);
    const link2 = await upload({ name: "s.txt", bytes: new Uint8Array([4, 5]) }, PASS);
    const good = makeIo(opts);
    expect(await run(["get", link2, "-o", "/d", "--passphrase-file", "good.txt"], good), good.err).toBe(EXIT.ok);
    expect(same(good.files.get("/d/s.txt"), new Uint8Array([4, 5]))).toBe(true);
  });

  it("a second get reports gone and writes nothing", async () => {
    const link = await upload({ name: "a.txt", bytes: new Uint8Array([1]) });
    const { opts } = setup({ dirs: ["/d"] });
    expect(await run(["get", link, "-o", "/d"], makeIo(opts))).toBe(EXIT.ok);
    const again = makeIo(opts);
    expect(await run(["get", link, "-o", "/d2"], again)).toBe(EXIT.usage); // /d2 missing is checked first
    const gone = makeIo({ ...opts, dirs: ["/d2"] });
    expect(await run(["get", link, "-o", "/d2"], gone)).toBe(EXIT.gone);
    expect(gone.files.size).toBe(0);
  });
});

describe("get -o on a text link", () => {
  async function textLink(text: string): Promise<string> {
    const made = await createCodec({ writeFormat: 2, pbkdf2Iterations: 1000 }).encryptSecret(text);
    const response = await routerFetch()(`${SERVER}/api/secrets?ttl=3600`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: made.blob,
    });
    const { id } = (await response.json()) as { id: string };
    return buildLink(SERVER, { id, key: made.key, format: 2, passphrase: false, file: false });
  }

  it("writes the text as UTF-8 without a newline", async () => {
    const link = await textLink("päss\nline two");
    const { opts } = setup({ dirs: ["/d"] });
    const io = makeIo(opts);
    expect(await run(["get", link, "-o", "/d/secret.txt"], io), io.err).toBe(EXIT.ok);
    expect(new TextDecoder().decode(io.files.get("/d/secret.txt"))).toBe("päss\nline two");
    expect(io.out).toBe("");
  });

  it("refuses an existing target or a directory before any request", async () => {
    const link = await textLink("x");
    const { rec, opts } = setup({ dirs: ["/d"], files: { "/d/there": "old" } });
    const a = makeIo(opts);
    expect(await run(["get", link, "-o", "/d/there"], a)).toBe(EXIT.usage);
    const b = makeIo(opts);
    expect(await run(["get", link, "-o", "/d"], b)).toBe(EXIT.usage);
    expect(b.err).toMatch(/file name/);
    expect(rec.methods).toEqual([]);
    expect(await status(link)).toBe(200);
  });

  it("without -o still prints the text as before, also on a terminal", async () => {
    const link = await textLink("plain");
    const { opts } = setup({ stdin: null, stdoutTty: true });
    const io = makeIo(opts);
    expect(await run(["get", link], io), io.err).toBe(EXIT.ok);
    expect(io.out).toBe("plain\n");
  });
});

describe("status on a file link", () => {
  it("says the file is waiting, and that a passphrase is needed for 2fp", async () => {
    const plain = await upload({ name: "a", bytes: new Uint8Array([1]) });
    const a = makeIo({ ...setup().opts, stdin: null });
    expect(await run(["status", plain], a)).toBe(EXIT.ok);
    expect(a.err).toContain("The file is still waiting.");
    const protectedLink = await upload({ name: "a", bytes: new Uint8Array([1]) }, PASS);
    const b = makeIo({ ...setup().opts, stdin: null });
    expect(await run(["status", protectedLink], b)).toBe(EXIT.ok);
    expect(b.err).toContain("The file is still waiting (it needs a passphrase).");
    expect(await status(plain)).toBe(200);
  });
});

/** A fetch that answers /api/limits as given and passes everything else to the real router. */
function withLimits(limits: Response | (() => Response | Promise<Response>), rec: Recorded): typeof fetch {
  const router = routerFetch(rec);
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (new Request(input, init).url.endsWith("/api/limits")) {
      rec.urls.push(`${SERVER}/api/limits`);
      rec.methods.push("GET");
      return typeof limits === "function" ? limits() : limits.clone();
    }
    return router(input, init);
  }) as typeof fetch;
}
const limitsJson = (over: Partial<{ maxFileBytes: number; maxFileTtl: number; maxTextBytes: number }>) =>
  Response.json({ maxFileBytes: 262_144, maxFileTtl: 3600, maxTextBytes: 16_384, ...over });

describe("send --file and the server's limits (GET /api/limits)", () => {
  const run1 = async (args: string[], limits: Response | (() => Response | Promise<Response>), extra: Parameters<typeof makeIo>[0] = {}) => {
    const rec: Recorded = { urls: [], methods: [] };
    const io = makeIo({ writeFiles: true, env: { ONETIME_SERVER: SERVER }, fetch: withLimits(limits, rec), ...extra });
    const code = await run(args, io);
    return { code, io, rec };
  };

  it("asks the server for its limits before reading the file, and text sends never ask", async () => {
    const { code, rec } = await run1(["send", "--file", "a"], limitsJson({}), { files: { a: "x" } });
    expect(code).toBe(EXIT.ok);
    expect(rec.methods).toEqual(["GET", "POST"]);
    const text = setup({ stdin: "hello" });
    expect(await run(["send"], makeIo(text.opts))).toBe(EXIT.ok);
    expect(text.rec.methods).toEqual(["POST"]);
  });

  it("refuses a file over the server's limit before uploading, naming that limit", async () => {
    const { code, io, rec } = await run1(["send", "--file", "a"], limitsJson({ maxFileBytes: 1000 }), { files: { a: new Uint8Array(1001) } });
    expect(code).toBe(EXIT.usage);
    expect(io.err).toContain("The file is too large (limit 1000 bytes).");
    expect(rec.methods).toEqual(["GET"]);
  });

  it("reads at most the server's limit from a pipe", async () => {
    const { code, io, rec } = await run1(["send", "--file", "-"], limitsJson({ maxFileBytes: 10 }), { stdin: new Uint8Array(11) });
    expect(code).toBe(EXIT.usage);
    expect(io.err).toContain("limit 10 bytes");
    expect(rec.methods).toEqual(["GET"]);
  });

  it("does not refuse locally a file above the hosted limit when the server says it takes it (the server decides)", async () => {
    const { code, io, rec } = await run1(["send", "--file", "a"], limitsJson({ maxFileBytes: 5_242_880 }), { files: { a: new Uint8Array(300_000).fill(1) } });
    // The test router is the hosted one and refuses this blob (413), which shows the CLI went on to upload.
    expect(code).toBe(EXIT.network);
    expect(io.err).toContain("The server does not accept files this large.");
    expect(rec.methods).toEqual(["GET", "POST"]);
  });

  it("falls back to the hosted limits when the server has no /api/limits, answers with an error, HTML or nonsense, or is unreachable", async () => {
    const answers: Array<() => Response | Promise<Response>> = [
      () => new Response("{}", { status: 404 }),
      () => new Response("{}", { status: 405 }),
      () => new Response("", { status: 301, headers: { Location: "https://elsewhere.example/api/limits" } }),
      () => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }),
      () => Response.json({ maxFileBytes: 99_999_999_999, maxFileTtl: 3600, maxTextBytes: 16_384 }),
      () => Response.json({ maxFileBytes: "big" }),
      () => new Response("x".repeat(5000), { status: 200 }),
      () => Promise.reject(new TypeError("network")),
    ];
    for (const answer of answers) {
      const over = await run1(["send", "--file", "a"], answer, { files: { a: new Uint8Array(MAX_FILE_BYTES + 1) } });
      expect(over.code).toBe(EXIT.usage);
      expect(over.io.err).toContain("The file is too large (limit 256.0 KB).");
      expect(over.rec.methods).toEqual(["GET"]);
      const within = await run1(["send", "--file", "a"], answer, { files: { a: new Uint8Array(MAX_FILE_BYTES).fill(1) } });
      expect(within.code, within.io.err).toBe(EXIT.ok);
    }
  });

  it("does not follow a redirect from /api/limits and does not read an oversized reply: both mean the hosted limits", async () => {
    let calls = 0;
    const redirect = await run1(
      ["send", "--file", "a"],
      () => (calls++, new Response("", { status: 302, headers: { Location: "https://elsewhere.example/api/limits" } })),
      { files: { a: new Uint8Array(MAX_FILE_BYTES + 1) } },
    );
    expect(calls).toBe(1);
    expect(redirect.code).toBe(EXIT.usage);
    expect(redirect.io.err).toContain("limit 256.0 KB");
    const huge = JSON.stringify({ maxFileBytes: 5_242_880, maxFileTtl: 86_400, maxTextBytes: 16_384, pad: "x".repeat(2000) });
    const big = await run1(["send", "--file", "a"], () => new Response(huge), { files: { a: new Uint8Array(MAX_FILE_BYTES + 1) } });
    expect(big.code).toBe(EXIT.usage);
    expect(big.io.err).toContain("limit 256.0 KB");
  });

  it("refuses at once when the server has files off (maxFileBytes 0), without reading the file or uploading", async () => {
    const { code, io, rec } = await run1(["send", "--file", "a"], limitsJson({ maxFileBytes: 0 }), { files: { a: "x" } });
    expect(code).toBe(EXIT.usage);
    expect(io.err).toContain("This server does not accept files.");
    expect(rec.methods).toEqual(["GET"]);
  });

  it("uses the server's file lifetime: the default ttl follows it, an explicit longer one is refused", async () => {
    const day = await run1(["send", "--file", "a"], limitsJson({ maxFileTtl: 86_400 }), { files: { a: "x" } });
    expect(day.code, day.io.err).toBe(EXIT.ok);
    expect(day.io.err).toContain("Expires in 1 day if not opened.");
    const hour = await run1(["send", "--file", "a"], limitsJson({ maxFileTtl: 3600 }), { files: { a: "x" } });
    expect(hour.io.err).toContain("Expires in 1 hour if not opened.");
    expect(hour.io.err).toContain("Files last at most 1 hour.");
    const week = await run1(["send", "--file", "a", "--ttl", "7d"], limitsJson({ maxFileTtl: 86_400 }), { files: { a: "x" } });
    expect(week.code).toBe(EXIT.usage);
    expect(week.io.err).toContain("Files can last at most 1 day on this server.");
    expect(week.rec.methods).toEqual(["GET"]);
  });

  it("never prints the link or key to stderr, and asks the limits from the chosen server only", async () => {
    const { io, rec } = await run1(["send", "--file", "a"], limitsJson({}), { files: { a: "x" } });
    expect(io.err).not.toContain("#2f");
    expect(rec.urls[0]).toBe(`${SERVER}/api/limits`);
  });
});
