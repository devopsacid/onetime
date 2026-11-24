import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { handle } from "../src/worker/index";
import { d1Store } from "../src/worker/store-d1";
import type { Io } from "../cli/core";
import type { Usage } from "../src/worker/usage";

export const SERVER = "https://onetime.test";

export interface Recorded {
  urls: string[];
  methods: string[];
}

/** A fetch wired straight to the real router and the test D1. */
export function routerFetch(rec?: Recorded, usage?: Usage): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    rec?.urls.push(request.url);
    rec?.methods.push(request.method);
    const ctx = createExecutionContext();
    const response = await handle(request, d1Store(env.DB), ctx, usage === undefined ? {} : { usage });
    await waitOnExecutionContext(ctx);
    return response;
  }) as typeof fetch;
}

export interface TestIo extends Io {
  out: string;
  err: string;
  prompts: string[];
  /** Raw bytes written with stdout.writeBytes, in order. */
  outBytes: Uint8Array[];
  /** The in-memory file system: existing and written files by path. */
  files: Map<string, Uint8Array>;
  removed: string[];
}

export function makeIo(opts: {
  stdin?: string | Uint8Array | null; // null = TTY
  stdoutTty?: boolean;
  prompt?: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  writeStdout?: (text: string) => void | Promise<void>;
  /** Hidden prompts answered in order; once used up, `prompt` is the answer. */
  promptQueue?: string[];
  /** Files readFile can see, by path. */
  files?: Record<string, string | Uint8Array>;
  /** Existing directories. */
  dirs?: string[];
  writeFormat?: 1 | 2;
  writeFiles?: boolean;
  /** writeFileExclusive creates the file, then fails (a full disk): the rejection says the file was created. */
  failWrite?: boolean;
  /** writeFileExclusive fails with EEXIST although stat said the path was free (a race). */
  raceExists?: boolean;
} = {}): TestIo {
  const bytesOf = (file: string | Uint8Array): Uint8Array => (typeof file === "string" ? new TextEncoder().encode(file) : file);
  const vfs = new Map<string, Uint8Array>(Object.entries(opts.files ?? {}).map(([path, file]) => [path, bytesOf(file)]));
  const dirs = new Set(opts.dirs ?? []);
  const io: TestIo = {
    out: "",
    err: "",
    prompts: [],
    outBytes: [],
    files: vfs,
    removed: [],
    version: "9.9.9",
    // workerd refuses the real 600,000 iterations; format 2 with a passphrase is proven against node:crypto in test/node.
    pbkdf2Iterations: 1000,
    ...(opts.writeFormat === undefined ? {} : { writeFormat: opts.writeFormat }),
    ...(opts.writeFiles === undefined ? {} : { writeFiles: opts.writeFiles }),
    readFile: async (path, max) => {
      const file = vfs.get(path);
      if (file === undefined) throw new Error("ENOENT");
      return file.subarray(0, max + 1);
    },
    stat: async (path) => (dirs.has(path) ? "dir" : vfs.has(path) ? "file" : "missing"),
    writeFileExclusive: async (path, bytes) => {
      if (opts.raceExists || dirs.has(path) || vfs.has(path)) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
      vfs.set(path, new Uint8Array(bytes));
      if (opts.failWrite) throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC", partial: true });
    },
    removeFile: async (path) => {
      io.removed.push(path);
      vfs.delete(path);
    },
    env: opts.env ?? {},
    fetch:
      opts.fetch ??
      ((() => {
        throw new Error("fetch must not be called");
      }) as typeof fetch),
    stdin: {
      isTTY: opts.stdin === null || opts.stdin === undefined,
      readBytes: async (max) => {
        const raw = typeof opts.stdin === "string" ? new TextEncoder().encode(opts.stdin) : (opts.stdin ?? new Uint8Array());
        return raw.subarray(0, max + 1);
      },
    },
    promptHidden: async (label) => {
      io.prompts.push(label);
      return opts.promptQueue?.shift() ?? opts.prompt ?? "";
    },
    stdout: {
      isTTY: opts.stdoutTty ?? false,
      write: opts.writeStdout ?? ((s) => void (io.out += s)),
      writeBytes: (bytes) => void io.outBytes.push(new Uint8Array(bytes)),
    },
    stderr: { write: (s) => void (io.err += s) },
  };
  return io;
}
