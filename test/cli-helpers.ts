import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { handle } from "../src/worker/index";
import { d1Store } from "../src/worker/store-d1";
import type { Io } from "../cli/core";

export const SERVER = "https://onetime.test";

export interface Recorded {
  urls: string[];
  methods: string[];
}

/** A fetch wired straight to the real router and the test D1. */
export function routerFetch(rec?: Recorded): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    rec?.urls.push(request.url);
    rec?.methods.push(request.method);
    const ctx = createExecutionContext();
    const response = await handle(request, d1Store(env.DB), ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }) as typeof fetch;
}

export interface TestIo extends Io {
  out: string;
  err: string;
  prompts: string[];
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
  writeFormat?: 1 | 2;
} = {}): TestIo {
  const io: TestIo = {
    out: "",
    err: "",
    prompts: [],
    version: "9.9.9",
    // workerd refuses the real 600,000 iterations; format 2 with a passphrase is proven against node:crypto in test/node.
    pbkdf2Iterations: 1000,
    ...(opts.writeFormat === undefined ? {} : { writeFormat: opts.writeFormat }),
    readFile: async (path, max) => {
      const file = opts.files?.[path];
      if (file === undefined) throw new Error("ENOENT");
      const raw = typeof file === "string" ? new TextEncoder().encode(file) : file;
      return raw.subarray(0, max + 1);
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
    stdout: { isTTY: opts.stdoutTty ?? false, write: opts.writeStdout ?? ((s) => void (io.out += s)) },
    stderr: { write: (s) => void (io.err += s) },
  };
  return io;
}
