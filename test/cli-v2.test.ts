import { describe, expect, it } from "vitest";
import { EXIT, parseArgs, parseLinkInput, run, UsageError } from "../cli/core";
import { createCodec } from "../src/web/crypto";
import { makeIo, routerFetch, SERVER, type Recorded } from "./cli-helpers";

const ID = "A".repeat(22);
const KEY = "B".repeat(43);
const PASS = "correct horse battery";
const writer = { writeFormat: 2 as const };

function setup(extra: Parameters<typeof makeIo>[0] = {}) {
  const rec: Recorded = { urls: [], methods: [] };
  return { rec, opts: { fetch: routerFetch(rec), env: { ONETIME_SERVER: SERVER }, ...extra } };
}

/** Creates a link with the CLI acting as a deploy-2 writer. */
async function send(secret: string, args: string[] = [], extra: Parameters<typeof makeIo>[0] = {}): Promise<string> {
  const { opts } = setup({ stdin: secret, writeFormat: 2, ...extra });
  const io = makeIo(opts);
  expect(await run(["send", ...args], io), io.err).toBe(EXIT.ok);
  return io.out.trim();
}

describe("parseLinkInput with v2 links", () => {
  it("parses 2 and 2p links and bare forms", () => {
    expect(parseLinkInput(`https://a.example/#2.${ID}.${KEY}`, "https://d.example")).toEqual({
      origin: "https://a.example",
      id: ID,
      key: KEY,
      format: 2,
      passphrase: false,
      file: false,
    });
    expect(parseLinkInput(`2p.${ID}.${KEY}`, "https://d.example")).toEqual({
      origin: "https://d.example",
      id: ID,
      key: KEY,
      format: 2,
      passphrase: true,
      file: false,
    });
    expect(parseLinkInput(`${ID}.${KEY}`, "https://d.example")).toMatchObject({ format: 1, passphrase: false });
  });
  it("flags cut-off, suffix and unknown-format links", () => {
    for (const bad of [
      `https://a.example/#${ID}.${KEY}.2`,
      `https://a.example/#3.${ID}.${KEY}`,
      `https://a.example/#2P.${ID}.${KEY}`,
      `https://a.example/#2.${ID}.${KEY.slice(1)}`,
      `https://a.example/#2p.${ID}`,
      `https://a.example/#2.2.${ID}.${KEY}`,
    ]) {
      expect(parseLinkInput(bad, "https://d.example"), bad).toBe("invalid");
    }
  });
});

describe("parseArgs for passphrase options", () => {
  it("accepts --passphrase and --passphrase-file on send and gen, and --passphrase-file on get", () => {
    expect(parseArgs(["send", "--passphrase"])).toMatchObject({ kind: "send", passphrase: "prompt" });
    expect(parseArgs(["send", "--passphrase-file", "p.txt"])).toMatchObject({ kind: "send", passphraseFile: "p.txt" });
    expect(parseArgs(["gen", "--passphrase"])).toMatchObject({ kind: "gen", passphrase: "prompt" });
    expect(parseArgs(["gen", "--passphrase-file=p.txt"])).toMatchObject({ kind: "gen", passphraseFile: "p.txt" });
    expect(parseArgs(["get", "L", "--passphrase-file", "p.txt"])).toMatchObject({ kind: "get", link: "L", passphraseFile: "p.txt" });
    expect(parseArgs(["send"])).not.toHaveProperty("passphrase");
  });
  it("refuses --passphrase=VALUE like a secret argument, without echoing it", () => {
    let message = "";
    try {
      parseArgs(["send", "--passphrase=hunter2hunter2"]);
    } catch (error) {
      message = (error as Error).message;
      expect(error).toBeInstanceOf(UsageError);
    }
    expect(message).toMatch(/history/);
    expect(message).not.toContain("hunter2");
    expect(() => parseArgs(["gen", "--passphrase=hunter2hunter2"])).toThrow(UsageError);
  });
  it("makes the two options exclusive, refuses them with gen --print-only, and has no --passphrase on get or status", () => {
    expect(() => parseArgs(["send", "--passphrase", "--passphrase-file", "p"])).toThrow(/either/);
    expect(() => parseArgs(["gen", "--passphrase", "--passphrase-file", "p"])).toThrow(/either/);
    expect(() => parseArgs(["gen", "--print-only", "--passphrase"])).toThrow(UsageError);
    expect(() => parseArgs(["gen", "--print-only", "--passphrase-file", "p"])).toThrow(UsageError);
    expect(() => parseArgs(["get", "--passphrase"])).toThrow(UsageError);
    expect(() => parseArgs(["status", "--passphrase-file", "p"])).toThrow(UsageError);
    expect(() => parseArgs(["send", "--passphrase-file"])).toThrow(UsageError);
  });
});

describe("a build with the writers off (WRITE_FORMAT 1 via the test hook)", () => {
  it("send and gen refuse both options as not available yet, before any request or prompt", async () => {
    for (const argv of [
      ["send", "--passphrase"],
      ["send", "--passphrase-file", "p"],
      ["gen", "--passphrase"],
      ["gen", "--passphrase-file", "p"],
    ]) {
      const { rec, opts } = setup({ stdin: "secret\n", files: { p: PASS }, writeFormat: 1 });
      const io = makeIo(opts);
      expect(await run(argv, io), argv.join(" ")).toBe(EXIT.usage);
      expect(io.err).toContain("not available yet");
      expect(io.out).toBe("");
      expect(io.prompts).toEqual([]);
      expect(rec.urls).toEqual([]);
    }
  });
  it("the help texts of send, gen and the overview do not list them yet; get lists --passphrase-file", async () => {
    for (const argv of [["send", "--help"], ["gen", "--help"]]) {
      const io = makeIo({ writeFormat: 1 });
      await run(argv, io);
      expect(io.out, argv.join(" ")).not.toContain("--passphrase");
    }
    const main = makeIo({ writeFormat: 1 });
    await run(["--help"], main);
    expect(main.out.split("\n").filter((line) => !line.includes("onetime get")).join("\n")).not.toContain("--passphrase");
    const writers = makeIo({ writeFormat: 2 });
    await run(["send", "--help"], writers);
    expect(writers.out).toContain("--passphrase-file PATH");
    const writersGen = makeIo({ writeFormat: 2 });
    await run(["gen", "--help"], writersGen);
    expect(writersGen.out).toContain("--passphrase");
    const writersMain = makeIo({ writeFormat: 2 });
    await run(["--help"], writersMain);
    expect(writersMain.out).toContain("onetime send [--ttl 1h|1d|7d|SECONDS] [--passphrase | --passphrase-file PATH]");
    const get = makeIo();
    await run(["get", "--help"], get);
    expect(get.out).toContain("--passphrase-file");
    expect(get.out).toContain("passphrase");
  });
  it("still writes format 1 links that new readers open", async () => {
    const { opts } = setup({ stdin: "old style\n", writeFormat: 1 });
    const io = makeIo(opts);
    expect(await run(["send"], io)).toBe(EXIT.ok);
    expect(io.out).toMatch(/#[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\n$/);
    const got = makeIo({ stdin: null, ...setup().opts });
    expect(await run(["get", io.out.trim()], got)).toBe(EXIT.ok);
    expect(got.out).toBe("old style");
  });
});

describe("get, status and v2 links", () => {
  it("a v2 link without a passphrase round trips, and the second get reports gone", async () => {
    const link = await send("plain v2\n");
    expect(link).toMatch(/#2\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    const first = makeIo({ stdin: null, ...setup().opts });
    expect(await run(["get", link], first)).toBe(EXIT.ok);
    expect(first.out).toBe("plain v2");
    const second = makeIo({ stdin: null, ...setup().opts });
    expect(await run(["get", link], second)).toBe(EXIT.gone);
  });

  it("a passphrase link opens with --passphrase-file (one trailing newline, CRLF or LF, is not part of it)", async () => {
    for (const file of [`${PASS}\n`, `${PASS}\r\n`, PASS, `${PASS}\nsecond line is ignored\n`]) {
      const link = await send("guarded\n", ["--passphrase-file", "p"], { files: { p: PASS } });
      expect(link).toMatch(/#2p\./);
      const io = makeIo({ stdin: null, files: { p: file }, ...setup().opts });
      expect(await run(["get", link, "--passphrase-file", "p"], io), io.err).toBe(EXIT.ok);
      expect(io.out).toBe("guarded");
    }
  });

  it("a passphrase link opens with the hidden prompt on a terminal", async () => {
    const link = await send("guarded\n", ["--passphrase-file", "p"], { files: { p: PASS } });
    const io = makeIo({ stdin: null, prompt: PASS, ...setup().opts });
    expect(await run(["get", link], io)).toBe(EXIT.ok);
    expect(io.prompts).toEqual(["Passphrase (input hidden, one try): "]);
    expect(io.out).toBe("guarded");
  });

  it("a wrong passphrase exits 4, says the secret is used up, and the link is then gone", async () => {
    const link = await send("guarded\n", ["--passphrase-file", "p"], { files: { p: PASS } });
    const io = makeIo({ stdin: null, prompt: "wrong horse battery", ...setup().opts });
    expect(await run(["get", link], io)).toBe(EXIT.decrypt);
    expect(io.err).toContain("Decryption failed: wrong passphrase, or the link was changed. The secret is now used up.");
    expect(io.out).toBe("");
    expect(io.err).not.toContain("wrong horse battery");
    const again = makeIo({ stdin: null, prompt: PASS, ...setup().opts });
    expect(await run(["get", link], again)).toBe(EXIT.gone);
  });

  it("a passphrase link without a terminal and without a file exits 2 and makes no request at all", async () => {
    const link = await send("guarded\n", ["--passphrase-file", "p"], { files: { p: PASS } });
    const { rec, opts } = setup({ stdin: link });
    const io = makeIo(opts);
    expect(await run(["get", "-"], io)).toBe(EXIT.usage);
    expect(io.err).toContain("This link needs a passphrase: run it in a terminal or use --passphrase-file.");
    expect(rec.urls).toEqual([]);
    expect(rec.methods).not.toContain("POST");
    // Piped link plus a file works.
    const ok = makeIo({ stdin: link, files: { p: PASS }, ...setup().opts });
    expect(await run(["get", "-", "--passphrase-file", "p"], ok)).toBe(EXIT.ok);
    expect(ok.out).toBe("guarded");
  });

  it("--passphrase-file on a link without a passphrase exits 2 before any request, for v1 and v2", async () => {
    const plain = await send("x\n");
    const v1 = `${SERVER}/#${ID}.${KEY}`;
    for (const link of [plain, v1]) {
      const { rec, opts } = setup({ stdin: null, files: { p: PASS } });
      const io = makeIo(opts);
      expect(await run(["get", link, "--passphrase-file", "p"], io)).toBe(EXIT.usage);
      expect(io.err).toContain("This link has no passphrase.");
      expect(rec.urls).toEqual([]);
    }
  });

  it("refuses an invalid passphrase before any request, whether typed or from a file, without echoing it", async () => {
    const link = await send("guarded\n", ["--passphrase-file", "p"], { files: { p: PASS } });
    for (const bad of ["short", "x".repeat(257), "abcd\u0007efghij"]) {
      for (const how of ["file", "prompt"] as const) {
        const { rec, opts } = setup(how === "file" ? { stdin: null, files: { p: bad } } : { stdin: null, prompt: bad });
        const io = makeIo(opts);
        const argv = how === "file" ? ["get", link, "--passphrase-file", "p"] : ["get", link];
        expect(await run(argv, io)).toBe(EXIT.usage);
        expect(io.err).toMatch(/8 to 256|control/);
        expect(io.err).not.toContain(bad);
        expect(rec.urls).toEqual([]);
      }
    }
    // The secret was never touched.
    const ok = makeIo({ stdin: null, prompt: PASS, ...setup().opts });
    expect(await run(["get", link], ok)).toBe(EXIT.ok);
  });

  it("passphrase file rules: at most 4,096 bytes, strict UTF-8, must be readable", async () => {
    const link = await send("guarded\n", ["--passphrase-file", "p"], { files: { p: PASS } });
    const cases: Array<[string, string | Uint8Array]> = [
      ["too big", "a".repeat(4097)],
      ["bad utf-8", Uint8Array.from([0x61, 0xff, 0xfe, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67])],
    ];
    for (const [name, content] of cases) {
      const { rec, opts } = setup({ stdin: null, files: { p: content } });
      const io = makeIo(opts);
      expect(await run(["get", link, "--passphrase-file", "p"], io), name).toBe(EXIT.usage);
      expect(rec.urls, name).toEqual([]);
    }
    const missing = makeIo({ stdin: null, ...setup().opts });
    expect(await run(["get", link, "--passphrase-file", "nope"], missing)).toBe(EXIT.usage);
    expect(missing.err).toContain("Could not read the passphrase file");
    // exactly 4,096 bytes of a (too long a passphrase) is still refused as a passphrase, not as a file
    const long = makeIo({ stdin: null, files: { p: "a".repeat(4096) }, ...setup().opts });
    expect(await run(["get", link, "--passphrase-file", "p"], long)).toBe(EXIT.usage);
    expect(long.err).toMatch(/8 to 256/);
  });

  it("status on a passphrase link says so and does not burn it", async () => {
    const link = await send("guarded\n", ["--passphrase-file", "p"], { files: { p: PASS } });
    const io = makeIo({ stdin: null, ...setup().opts });
    expect(await run(["status", link], io)).toBe(EXIT.ok);
    expect(io.err).toContain("The secret is still waiting (it needs a passphrase).");
    const again = makeIo({ stdin: null, prompt: PASS, ...setup().opts });
    expect(await run(["get", link], again)).toBe(EXIT.ok);
  });

  it("the damaged-link exit is used for cut-off v2 links, with no request", async () => {
    const link = await send("x\n");
    const { rec, opts } = setup({ stdin: null });
    const io = makeIo(opts);
    expect(await run(["get", link.slice(0, -5)], io)).toBe(EXIT.badLink);
    expect(rec.urls).toEqual([]);
  });
});

describe("the default build writes format 2 (since deploy 2)", () => {
  it("send makes a #2. link and the help lists the passphrase options without 'not available'", async () => {
    const { opts } = setup({ stdin: "new style\n" });
    const io = makeIo(opts);
    expect(await run(["send"], io)).toBe(EXIT.ok);
    expect(io.out).toMatch(/#2\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\n$/);
    for (const argv of [["--help"], ["send", "--help"], ["gen", "--help"]]) {
      const help = makeIo();
      await run(argv, help);
      expect(help.out, argv.join(" ")).toContain("--passphrase-file");
      expect(help.out, argv.join(" ")).not.toContain("not available");
    }
    const bad = makeIo({ stdin: null });
    expect(await run(["get", "garbage"], bad)).toBe(EXIT.badLink);
    expect(bad.err).toContain("https://<host>/#2.<id>.<key>");
  });
});

describe("send and gen with a passphrase (active once WRITE_FORMAT is 2)", () => {
  it("send --passphrase on a terminal asks twice, in order, and hints without the passphrase", async () => {
    const { opts } = setup({ stdin: null, promptQueue: ["the secret", PASS, PASS], ...writer });
    const io = makeIo(opts);
    expect(await run(["send", "--passphrase"], io)).toBe(EXIT.ok);
    expect(io.prompts).toEqual(["Secret (input hidden): ", "Passphrase (input hidden): ", "Repeat passphrase: "]);
    expect(io.out).toMatch(/#2p\./);
    expect(io.err).toContain("Send the passphrase separately. A wrong one destroys the secret.");
    expect(io.err).not.toContain(PASS);
    expect(io.out).not.toContain(PASS);
  });

  it("a mismatch between the two entries is a usage error and nothing is sent", async () => {
    const { rec, opts } = setup({ stdin: null, promptQueue: ["the secret", PASS, "another passphrase"], ...writer });
    const io = makeIo(opts);
    expect(await run(["send", "--passphrase"], io)).toBe(EXIT.usage);
    expect(io.err).toContain("The two passphrases differ.");
    expect(rec.urls).toEqual([]);
  });

  it("send --passphrase with a piped secret is refused and points to --passphrase-file", async () => {
    const { rec, opts } = setup({ stdin: "piped\n", ...writer });
    const io = makeIo(opts);
    expect(await run(["send", "--passphrase"], io)).toBe(EXIT.usage);
    expect(io.err).toContain("use --passphrase-file when the secret is piped");
    expect(rec.urls).toEqual([]);
  });

  it("send --passphrase-file works with a piped secret and refuses a bad passphrase before any request", async () => {
    const ok = makeIo({ ...setup({ stdin: "piped\n", files: { p: `${PASS}\n` }, ...writer }).opts });
    expect(await run(["send", "--passphrase-file", "p"], ok)).toBe(EXIT.ok);
    expect(ok.out).toMatch(/#2p\./);
    const { rec, opts } = setup({ stdin: "piped\n", files: { p: "short" }, ...writer });
    const bad = makeIo(opts);
    expect(await run(["send", "--passphrase-file", "p"], bad)).toBe(EXIT.usage);
    expect(rec.urls).toEqual([]);
  });

  it("gen --passphrase-file makes a link whose secret is not printed, with the passphrase hint", async () => {
    const { opts } = setup({ stdin: null, files: { p: PASS }, ...writer });
    const io = makeIo(opts);
    expect(await run(["gen", "--type", "hex", "--length", "16", "--passphrase-file", "p"], io)).toBe(EXIT.ok);
    expect(io.out).toMatch(/#2p\./);
    expect(io.err).toContain("Send the passphrase separately.");
    const got = makeIo({ stdin: null, files: { p: PASS }, ...setup().opts });
    expect(await run(["get", io.out.trim(), "--passphrase-file", "p"], got)).toBe(EXIT.ok);
    expect(got.out).toMatch(/^[0-9a-f]{32}$/);
  });

  it("gen --passphrase without a terminal is refused (the prompt needs one)", async () => {
    const { rec, opts } = setup({ stdin: "", ...writer });
    const io = makeIo(opts);
    expect(await run(["gen", "--passphrase"], io)).toBe(EXIT.usage);
    expect(io.err).toContain("--passphrase-file");
    expect(rec.urls).toEqual([]);
  });

  it("without a passphrase a writer makes a plain v2 link and no passphrase hint", async () => {
    const { opts } = setup({ stdin: "x\n", ...writer });
    const io = makeIo(opts);
    expect(await run(["send"], io)).toBe(EXIT.ok);
    expect(io.out).toMatch(/#2\./);
    expect(io.err).not.toContain("passphrase");
  });
});

describe("damaged-link message", () => {
  it("shows the v1 shape while readers only, the v2 shape once writers ship", async () => {
    const readers = makeIo({ stdin: null, writeFormat: 1 });
    expect(await run(["get", "garbage"], readers)).toBe(EXIT.badLink);
    expect(readers.err).toContain("https://<host>/#<id>.<key>");
    const writers = makeIo({ stdin: null, writeFormat: 2 });
    expect(await run(["get", "garbage"], writers)).toBe(EXIT.badLink);
    expect(writers.err).toContain("https://<host>/#2.<id>.<key>");
  });
});

describe("limits and hints", () => {
  it("builds the near-full --ttl hint from the validated maxTtl", async () => {
    const hint = async (maxTtl: number) => {
      const full = (async () =>
        new Response(JSON.stringify({ error: "x", maxTtl }), { status: 409, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
      const io = makeIo({ stdin: "s\n", fetch: full });
      expect(await run(["send", "--ttl", "7d", "--server", SERVER], io)).toBe(EXIT.network);
      return io.err;
    };
    expect(await hint(3600)).toContain("--ttl 1h or shorter");
    expect(await hint(3600)).not.toContain("--ttl 1d");
    expect(await hint(86400)).toContain("--ttl 1d or shorter");
    expect(await hint(604800)).toContain("--ttl 7d or shorter");
    expect(await hint(7200)).toContain("--ttl 7200 or shorter");
    expect(await hint(120)).toContain("--ttl 120 or shorter");
  });

  it("reads a 5,243,298-byte reveal and refuses 5,243,299", async () => {
    const link = `${SERVER}/#2.${ID}.${KEY}`;
    const answer = (size: number, declared = true) =>
      (async () =>
        new Response(new Uint8Array(size), { status: 200, headers: declared ? { "Content-Length": String(size) } : {} })) as unknown as typeof fetch;
    // 5,243,298 passes the size cap and then fails to decrypt (exit 4); one more is refused by the cap (exit 5), declared or not.
    expect(await run(["get", link], makeIo({ fetch: answer(5_243_298), stdin: null }))).toBe(EXIT.decrypt);
    expect(await run(["get", link], makeIo({ fetch: answer(5_243_299), stdin: null }))).toBe(EXIT.network);
    expect(await run(["get", link], makeIo({ fetch: answer(5_243_299, false), stdin: null }))).toBe(EXIT.network);
  });

  it("sends and gets a 16,384-byte secret as a 16,418-byte blob", async () => {
    const big = "y".repeat(16_384);
    const link = await send(big);
    const io = makeIo({ stdin: null, ...setup().opts });
    expect(await run(["get", link], io)).toBe(EXIT.ok);
    expect(io.out).toBe(big);
  });

  it("interoperates with the browser codec both ways", async () => {
    const codec = createCodec({ writeFormat: 2, pbkdf2Iterations: 1000 });
    const made = await codec.encryptSecret("from the page", PASS);
    const post = await routerFetch()(`${SERVER}/api/secrets?ttl=3600`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: made.blob });
    const { id } = (await post.json()) as { id: string };
    const io = makeIo({ stdin: null, files: { p: PASS }, ...setup().opts });
    expect(await run(["get", `${SERVER}/#2p.${id}.${made.key}`, "--passphrase-file", "p"], io)).toBe(EXIT.ok);
    expect(io.out).toBe("from the page");
  });
});
