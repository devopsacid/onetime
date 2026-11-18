import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { handle } from "../src/worker/index";
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
    const response = await handle(request, env, ctx);
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
} = {}): TestIo {
  const io: TestIo = {
    out: "",
    err: "",
    prompts: [],
    version: "9.9.9",
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
      return opts.prompt ?? "";
    },
    stdout: { isTTY: opts.stdoutTty ?? false, write: opts.writeStdout ?? ((s) => void (io.out += s)) },
    stderr: { write: (s) => void (io.err += s) },
  };
  return io;
}
