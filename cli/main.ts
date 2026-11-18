import { run, type Io } from "./core";

declare const __VERSION__: string | undefined;

/** Reads all of stdin. Understands a UTF-8 or UTF-16LE byte order mark (Windows PowerShell 5 pipes UTF-16). */
async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const bytes = Buffer.concat(chunks);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString("utf8");
  return bytes.toString("utf8");
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
  stdin: { isTTY: process.stdin.isTTY === true, readAll: readAllStdin },
  promptHidden,
  stdout: { isTTY: process.stdout.isTTY === true, write: (text) => void process.stdout.write(text) },
  stderr: { write: (text) => void process.stderr.write(text) },
};

// A closed pipe (for example `onetime get ... | head -c 1`) is not an error worth a stack trace.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

process.exitCode = await run(process.argv.slice(2), io);
