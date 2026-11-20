import { run, type Io } from "./core";
import { readFileBytes, removeFile, statPath, writeFileExclusive } from "./fs-io";

declare const __VERSION__: string | undefined;
declare const __DEFAULT_SERVER__: string | undefined;

/** Reads stdin up to `max + 1` bytes, then stops (the core rejects the overflow). */
async function readStdinBytes(max: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
    total += (chunk as Buffer).length;
    if (total > max) break;
  }
  return Buffer.concat(chunks).subarray(0, max + 1);
}

/** Hidden input on the terminal using raw mode only (no stty, no /dev/tty): works on Linux, macOS and Windows. */
function promptHidden(label: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let text = "";
    let escape: "none" | "start" | "csi" = "none";
    process.stderr.write(label);
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();

    const finish = (interrupted: boolean): void => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      if (interrupted) process.exit(130);
      resolve(text);
    };

    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (escape === "start") {
          escape = ch === "[" || ch === "O" ? "csi" : "none";
          continue;
        }
        if (escape === "csi") {
          if (ch >= "@" && ch <= "~") escape = "none";
          continue;
        }
        if (ch === "\x03") return finish(true);
        if (ch === "\r" || ch === "\n" || ch === "\x04") return finish(false);
        if (ch === "\x1b") escape = "start";
        else if (ch === "\x7f" || ch === "\b") text = [...text].slice(0, -1).join("");
        else if (ch >= " ") text += ch;
      }
    };
    stdin.on("data", onData);
  });
}

const io: Io = {
  fetch: globalThis.fetch,
  env: process.env,
  version: typeof __VERSION__ === "string" ? __VERSION__ : "dev",
  defaultServer: typeof __DEFAULT_SERVER__ === "string" ? __DEFAULT_SERVER__ : undefined,
  stdin: { isTTY: process.stdin.isTTY === true, readBytes: readStdinBytes },
  promptHidden,
  readFile: readFileBytes,
  stat: statPath,
  writeFileExclusive,
  removeFile,
  stdout: {
    isTTY: process.stdout.isTTY === true,
    write: (text) =>
      new Promise<void>((resolve, reject) => {
        process.stdout.write(text, (error) => (error ? reject(error) : resolve()));
      }),
    writeBytes: (bytes) =>
      new Promise<void>((resolve, reject) => {
        process.stdout.write(bytes, (error) => (error ? reject(error) : resolve()));
      }),
  },
  stderr: { write: (text) => void process.stderr.write(text) },
};

// A closed pipe (for example `onetime get ... | head -c 1`) is not an error worth a stack trace.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

process.exitCode = await run(process.argv.slice(2), io);
