import { describe, expect, it } from "vitest";
import { EXIT, run } from "../cli/core";
import { createCodec, decryptSecret, encryptSecret } from "../src/web/crypto";
import { fromBase64Url } from "../src/web/base64url";
import { parseFragment } from "../src/web/link";
import { makeIo, routerFetch, SERVER, type Recorded } from "./cli-helpers";

// Writers make format 2 links since deploy 2: #2.<id>.<key>.
const LINK_RE = /^https:\/\/onetime\.test\/#2\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\n$/;
const fetchOpt = () => ({ fetch: routerFetch(), env: { ONETIME_SERVER: SERVER } });

async function send(text: string, extra: string[] = []): Promise<string> {
  const io = makeIo({ stdin: text, ...fetchOpt() });
  expect(await run(["send", ...extra], io)).toBe(EXIT.ok);
  expect(io.out).toMatch(LINK_RE);
  return io.out.trim();
}

async function get(link: string, args: string[] = []) {
  const io = makeIo({ stdin: null, ...fetchOpt() });
  const code = await run(["get", link, ...args], io);
  return { code, io };
}

describe("CLI send -> browser decrypt", () => {
  it("API reveal + decryptSecret returns the text", async () => {
    const text = "pässwörd 🔐\nline two";
    const link = await send(`${text}\n`);
    const parsed = parseFragment(new URL(link).hash);
    if (parsed === null || parsed === "invalid") throw new Error("bad link");
    const response = await routerFetch()(`${SERVER}/api/secrets/${parsed.id}/reveal`, { method: "POST" });
    const blob = new Uint8Array(await response.arrayBuffer());
    expect(blob.length).toBeGreaterThan(28);
    expect(await decryptSecret(blob, parsed)).toBe(text);
  });
  it("prints only the link on stdout and hints on stderr", async () => {
    const io = makeIo({ stdin: "x\n", ...fetchOpt() });
    await run(["send", "--ttl", "1h"], io);
    expect(io.out).toMatch(LINK_RE);
    expect(io.err).toMatch(/1 hour/);
    expect(io.err).toMatch(/onetime get/);
  });
  it("prompts when stdin is a TTY", async () => {
    const io = makeIo({ stdin: null, prompt: "typed secret", ...fetchOpt() });
    expect(await run(["send"], io)).toBe(EXIT.ok);
    expect(io.prompts.length).toBe(1);
    const got = await get(io.out.trim());
    expect(got.io.out).toBe("typed secret");
  });
  it("sends nothing secret to the server in URLs", async () => {
    const rec: Recorded = { urls: [], methods: [] };
    const io = makeIo({ stdin: "s3cret\n", fetch: routerFetch(rec), env: { ONETIME_SERVER: SERVER } });
    await run(["send"], io);
    const key = io.out.trim().split(".").at(-1)!;
    expect(rec.urls.join(" ")).not.toContain(key);
    expect(rec.urls.join(" ")).not.toContain("#");
  });
});

describe("browser encrypt -> CLI get", () => {
  it("returns unicode and multi-line text exactly", async () => {
    for (const text of ["héllo wörld ✓ 日本語 🚀", "a\nb\r\nc\n\nlast ", "x"]) {
      const { blob, key, format } = await encryptSecret(text);
      expect(format).toBe(2);
      const created = await routerFetch()(`${SERVER}/api/secrets?ttl=3600`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: blob,
      });
      const { id } = (await created.json()) as { id: string };
      const { code, io } = await get(`${SERVER}/#2.${id}.${key}`);
      expect(code).toBe(EXIT.ok);
      expect(io.out).toBe(text); // stdout is not a TTY: no trailing newline added
    }
  });
  it("still opens format 1 links made by older writers", async () => {
    const { blob, key } = await createCodec({ writeFormat: 1 }).encryptSecret("old link");
    const created = await routerFetch()(`${SERVER}/api/secrets?ttl=3600`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: blob,
    });
    const { id } = (await created.json()) as { id: string };
    const { code, io } = await get(`${SERVER}/#${id}.${key}`);
    expect(code).toBe(EXIT.ok);
    expect(io.out).toBe("old link");
  });
});

describe("CLI send -> CLI get", () => {
  it("round trips, then reports gone", async () => {
    const link = await send("one-shot\n");
    const first = await get(link);
    expect(first.code).toBe(EXIT.ok);
    expect(first.io.out).toBe("one-shot");
    const second = await get(link);
    expect(second.code).toBe(EXIT.gone);
    expect(second.io.out).toBe("");
    expect(second.io.err).toMatch(/already|expired/i);
  });
  it("accepts id.key with the server from env, and a link from stdin", async () => {
    const link = await send("viaenv");
    const idKey = link.split("#")[1]!;
    const a = await get(idKey);
    expect(a.io.out).toBe("viaenv");
    const link2 = await send("viastdin");
    const io = makeIo({ stdin: `${link2}\n`, ...fetchOpt() });
    expect(await run(["get", "-"], io)).toBe(EXIT.ok);
    expect(io.out).toBe("viastdin");
    expect(io.err).not.toMatch(/history/);
  });
  it("adds a trailing newline only on a TTY", async () => {
    const link = await send("tty");
    const io = makeIo({ stdin: null, stdoutTty: true, ...fetchOpt() });
    await run(["get", link], io);
    expect(io.out).toBe("tty\n");
  });
  it("wrong key -> decryption failed exit code, key not printed", async () => {
    const link = await send("secret");
    const [base, key] = [link.slice(0, link.lastIndexOf(".") + 1), link.slice(link.lastIndexOf(".") + 1)];
    const wrong = base + (key[0] === "A" ? "B" : "A") + key.slice(1);
    const { code, io } = await get(wrong);
    expect(code).toBe(EXIT.decrypt);
    expect(io.err).not.toContain(key);
    expect(io.out).toBe("");
  });
  it("uses the link's own origin over --server", async () => {
    const link = await send("origin");
    const { code, io } = await get(link, ["--server", "https://other.invalid"]);
    expect(code).toBe(EXIT.ok);
    expect(io.out).toBe("origin");
  });
});

describe("status", () => {
  it("waits, does not burn, then gone", async () => {
    const link = await send("peek");
    for (let i = 0; i < 2; i++) {
      const io = makeIo({ stdin: null, ...fetchOpt() });
      expect(await run(["status", link], io)).toBe(EXIT.ok);
      expect(io.out).toBe("");
      expect(io.err).toMatch(/waiting/i);
    }
    expect((await get(link)).io.out).toBe("peek");
    const io = makeIo({ stdin: null, ...fetchOpt() });
    expect(await run(["status", link], io)).toBe(EXIT.gone);
  });
});

describe("gen", () => {
  async function gen(args: string[]) {
    const io = makeIo({ stdin: null, ...fetchOpt() });
    expect(await run(["gen", ...args], io)).toBe(EXIT.ok);
    expect(io.out).toMatch(LINK_RE);
    const got = await get(io.out.trim());
    return { secret: got.io.out, io };
  }
  it("default is a 24 char password and the secret is not printed", async () => {
    const { secret, io } = await gen([]);
    expect(secret).toHaveLength(24);
    expect(io.err).not.toContain(secret);
  });
  it("respects type, length and flags", async () => {
    expect((await gen(["--type", "hex", "--length", "20"])).secret).toMatch(/^[0-9a-f]{40}$/);
    const b64 = (await gen(["--type", "base64url", "--length", "16"])).secret;
    expect(fromBase64Url(b64)).toHaveLength(16);
    expect((await gen(["--type", "uuid"])).secret).toMatch(/^[0-9a-f-]{36}$/);
    for (let i = 0; i < 20; i++) {
      const { secret } = await gen(["--length", "40", "--no-symbols", "--no-lookalikes"]);
      expect(secret).toMatch(/^[A-HJ-NP-Za-km-np-z2-9]{40}$/);
    }
  });
  it("--show prints the secret labelled on stderr", async () => {
    const io = makeIo({ stdin: null, ...fetchOpt() });
    await run(["gen", "--show", "--type", "hex"], io);
    const link = io.out.trim();
    const secret = (await get(link)).io.out;
    expect(io.err).toContain(secret);
    expect(io.err).toMatch(/secret/i);
    expect(io.out).not.toContain(secret);
  });
});

describe("largest v2 blob through the real router", () => {
  const codec = createCodec({ writeFormat: 2, pbkdf2Iterations: 1000 });
  const post = (body: Uint8Array) =>
    routerFetch()(`${SERVER}/api/secrets?ttl=3600`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body });

  it("stores a 16,384-byte secret as a 16,418-byte blob and returns the same bytes", async () => {
    const text = "x".repeat(16_384);
    const made = await codec.encryptSecret(text);
    expect(made.blob.length).toBe(16_418);
    const created = await post(made.blob);
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const revealed = await routerFetch()(`${SERVER}/api/secrets/${id}/reveal`, { method: "POST" });
    const blob = new Uint8Array(await revealed.arrayBuffer());
    expect(blob).toEqual(made.blob);
    expect(await codec.decryptSecret(blob, { key: made.key, format: 2, passphrase: false, file: false })).toBe(text);
  });

  it("answers 413 for 131,491 bytes", async () => {
    expect((await post(new Uint8Array(131_491).fill(1))).status).toBe(413);
  });
});
