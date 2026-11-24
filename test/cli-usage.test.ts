import { describe, expect, it } from "vitest";
import { EXIT, run } from "../cli/core";
import type { Usage } from "../src/worker/usage";
import { makeIo, routerFetch, SERVER, type Recorded } from "./cli-helpers";

const PASS = "correct horse battery";

function setup(extra: Parameters<typeof makeIo>[0] = {}) {
  const rec: Recorded = { urls: [], methods: [] };
  const calls: [string, string][] = [];
  const usage: Usage = { count: (event, label) => void calls.push([event, label]) };
  return { rec, calls, opts: { fetch: routerFetch(rec, usage), env: { ONETIME_SERVER: SERVER }, writeFormat: 2 as const, writeFiles: true, ...extra } };
}

const paths = (rec: Recorded) => rec.urls.map((u) => u.slice(SERVER.length));

async function send(argv: string[], extra: Parameters<typeof makeIo>[0] = {}) {
  const s = setup({ stdin: "secret\n", files: { "pp.txt": PASS, "a.bin": new Uint8Array([1, 2, 3]) }, ...extra });
  const io = makeIo(s.opts);
  const code = await run(["send", ...argv], io);
  expect(code, io.err).toBe(EXIT.ok);
  return { ...s, link: io.out.trim(), io };
}

describe("the CLI tells the server the kind of link", () => {
  it.each([
    ["a text", [], "text"],
    ["a text with a passphrase file", ["--passphrase-file", "pp.txt"], "text-pass"],
    ["a file", ["--file", "a.bin"], "file"],
    ["a file with a passphrase file", ["--file", "a.bin", "--passphrase-file", "pp.txt"], "file-pass"],
  ])("send of %s counts create/%s and puts only ttl and kind in the URL", async (_n, argv, kind) => {
    const { rec, calls } = await send(argv);
    expect(calls).toEqual([["create", kind]]);
    const post = paths(rec).filter((p) => p.startsWith("/api/secrets?"));
    expect(post).toEqual([`/api/secrets?ttl=3600&kind=${kind}`]);
  });

  it.each([
    ["a text", [], "text", "#2."],
    ["a text with a passphrase", ["--passphrase-file", "pp.txt"], "text-pass", "#2p."],
    ["a file", ["--file", "a.bin"], "file", "#2f."],
    ["a file with a passphrase", ["--file", "a.bin", "--passphrase-file", "pp.txt"], "file-pass", "#2fp."],
  ])("get of %s counts reveal/%s, then gone/%s, with only kind in the URL", async (_n, argv, kind, prefix) => {
    const made = await send(argv);
    expect(made.link).toContain(prefix);
    const rec: Recorded = { urls: [], methods: [] };
    const calls: [string, string][] = [];
    const usage: Usage = { count: (e, l) => void calls.push([e, l]) };
    // The same store: the router behind routerFetch is the shared test D1.
    const opts = { fetch: routerFetch(rec, usage), env: { ONETIME_SERVER: SERVER }, writeFormat: 2 as const, writeFiles: true, files: { "pp.txt": PASS }, dirs: ["/out"] };
    const getArgv = ["get", made.link, "-o", "/out/x.bin", ...(kind.endsWith("pass") ? ["--passphrase-file", "pp.txt"] : [])];
    const first = makeIo(opts);
    expect(await run(kind.startsWith("file") ? getArgv : getArgv.filter((a, i) => !(a === "-o" || i === 3)), first), first.err).toBe(EXIT.ok);
    expect(calls).toEqual([["reveal", kind]]);
    expect(paths(rec).at(-1)).toMatch(new RegExp(`^/api/secrets/[^/?]+/reveal\\?kind=${kind}$`));
    const second = makeIo(opts);
    expect(await run(kind.startsWith("file") ? [...getArgv.slice(0, 3), "/out/y.bin", ...getArgv.slice(4)] : getArgv.filter((a, i) => !(a === "-o" || i === 3)), second)).toBe(EXIT.gone);
    expect(calls).toEqual([["reveal", kind], ["gone", kind]]);
  });

  it("a v1 link counts as text", async () => {
    const s = setup({ writeFormat: 1, writeFiles: false, stdin: "old\n" });
    const io = makeIo(s.opts);
    expect(await run(["send"], io)).toBe(EXIT.ok);
    expect(io.out).toMatch(/#[^.2][^.]*\.[^.]+$/);
    expect(s.calls).toEqual([["create", "text"]]);
    const get = makeIo({ ...s.opts });
    expect(await run(["get", io.out.trim()], get)).toBe(EXIT.ok);
    expect(s.calls).toEqual([["create", "text"], ["reveal", "text"]]);
  });

  it("status sends no kind and counts nothing", async () => {
    const made = await send([]);
    const s = setup();
    const io = makeIo(s.opts);
    expect(await run(["status", made.link], io)).toBe(EXIT.ok);
    expect(paths(s.rec)).toEqual([expect.stringMatching(/^\/api\/secrets\/[^/?]+$/)]);
    expect(s.calls).toEqual([]);
  });

  it("stdout carries only the link and stderr never holds the kind query", async () => {
    const made = await send(["--passphrase-file", "pp.txt"]);
    expect(made.io.out).toMatch(/^https:\/\/\S+\n$/);
    expect(made.io.err).not.toContain("kind=");
  });
});
