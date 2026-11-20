import { createCodec, SecretTooLargeError, WRITE_FILES, WRITE_FORMAT } from "../src/web/crypto";
import { formatBytes, riskyFile, safeFileName } from "../src/web/filename";
import { normalizePassphrase, validatePassphrase } from "../src/web/passphrase";
import {
  generatePassword,
  generateToken,
  generateUuid,
  PASSWORD_LENGTH,
  TOKEN_BYTES,
  type CharsetName,
} from "../src/web/generate";
import { buildLink, parseFragment, type SecretLink } from "../src/web/link";
import {
  DEFAULT_TTL_SECONDS,
  ID_PATTERN,
  FORMAT_MAX_BLOB_BYTES,
  FORMAT_MAX_FILE_BYTES,
  HOSTED_LIMITS,
  parseLimits,
  type ServerLimits,
  MAX_SECRET_BYTES,
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
} from "../src/shared/limits";

export const DEFAULT_SERVER = "https://onetimepass.pages.dev";

export const EXIT = { ok: 0, gone: 1, usage: 2, badLink: 3, decrypt: 4, network: 5, internal: 70, interrupted: 130 } as const;

export class UsageError extends Error {}

/** Everything the core needs from the outside world, so tests can inject it. */
export interface Io {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  version: string;
  /** Server used when neither --server nor ONETIME_SERVER is given (a self-host build injects its own origin). */
  defaultServer?: string;
  /** Reads at most `max + 1` bytes of stdin (one extra byte lets the core see an overflow). */
  stdin: { isTTY: boolean; readBytes(max: number): Promise<Uint8Array> };
  promptHidden(label: string): Promise<string>;
  /** Reads at most `max + 1` bytes of a file (one extra byte lets the core see an overflow). Rejects when it cannot be read. */
  readFile(path: string, max: number): Promise<Uint8Array>;
  /** Test hook, never set by main.ts: PBKDF2 rounds (workerd refuses the real 600,000). */
  pbkdf2Iterations?: number;
  /** Test hook, never set by main.ts: pretend WRITE_FORMAT is this (to test the writers before the flip). */
  writeFormat?: 1 | 2;
  /** Test hook, never set by main.ts: pretend WRITE_FILES is this (to test `send --file` before the flip). */
  writeFiles?: boolean;
  /** What is at `path`, following symlinks; a dangling symlink counts as "file" (it exists and must not be written through). */
  stat(path: string): Promise<"dir" | "file" | "missing">;
  /**
   * Creates `path` with O_CREAT | O_EXCL | O_WRONLY and mode 0600 (never overwrites, never follows a symlink at the end)
   * and writes `bytes`. Rejects with `code: "EEXIST"` if the path exists. If it failed after creating the file it rejects
   * with `partial: true`, and the caller removes it.
   */
  writeFileExclusive(path: string, bytes: Uint8Array): Promise<void>;
  /** Removes a file this process created. */
  removeFile(path: string): Promise<void>;
  stdout: { isTTY: boolean; write(text: string): void | Promise<void>; writeBytes(bytes: Uint8Array): void | Promise<void> };
  stderr: { write(text: string): void };
}

// ---------- small helpers ----------

/** Strips exactly one trailing newline (LF or CRLF), as `echo` and PowerShell add one. */
export function stripOneNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

/** Largest stdin input accepted (UTF-16 doubles the size of the text). */
export const MAX_INPUT_BYTES = MAX_SECRET_BYTES * 4;
const MAX_JSON_BYTES = 4096;

/** Decodes piped input as UTF-8 or UTF-16LE (by byte order mark); refuses anything that is not valid. */
export function decodeInput(bytes: Uint8Array): string {
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      if (bytes.length % 2 !== 0) throw new Error("odd");
      return new TextDecoder("utf-16le", { fatal: true, ignoreBOM: false }).decode(bytes.subarray(2));
    }
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new UsageError("The input is not valid UTF-8 text. Use the interactive prompt, or pipe UTF-8.");
  }
}

const TTL_PRESETS: Record<string, number> = { "1h": 3600, "1d": 86400, "7d": 604800 };

export function parseTtl(text: string): number {
  const preset = TTL_PRESETS[text];
  if (preset !== undefined) return preset;
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    if (seconds >= MIN_TTL_SECONDS && seconds <= MAX_TTL_SECONDS) return seconds;
  }
  throw new UsageError(`Invalid --ttl "${text}". Use 1h, 1d, 7d or seconds from ${MIN_TTL_SECONDS} to ${MAX_TTL_SECONDS}.`);
}

function describeTtl(seconds: number): string {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (seconds % 86400 === 0) return plural(seconds / 86400, "day");
  if (seconds % 3600 === 0) return plural(seconds / 3600, "hour");
  if (seconds % 60 === 0) return plural(seconds / 60, "minute");
  return plural(seconds, "second");
}

function isAllowedOrigin(url: URL): boolean {
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

/** Picks --server, then ONETIME_SERVER, then the default; returns a bare origin. */
export function resolveServer(flag: string | undefined, env: Record<string, string | undefined>, defaultServer: string = DEFAULT_SERVER): string {
  const text = flag ?? (env.ONETIME_SERVER ? env.ONETIME_SERVER : defaultServer);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new UsageError(`Invalid server URL "${text}".`);
  }
  if (!isAllowedOrigin(url)) {
    throw new UsageError("The server must use https (http is allowed only for localhost and 127.0.0.1).");
  }
  return url.origin;
}

export interface ParsedLink extends SecretLink {
  origin: string;
}

/** Accepts a full link or `<id>.<key>`. Returns "invalid" without ever echoing the input. */
export function parseLinkInput(input: string, defaultOrigin: string, explicitServer?: string): ParsedLink | "invalid" {
  const text = input.trim();
  if (text === "") return "invalid";
  let origin = defaultOrigin;
  let fragment: string;
  if (text.includes("://")) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return "invalid";
    }
    if (!isAllowedOrigin(url)) return "invalid";
    if (url.protocol === "http:" && url.origin !== explicitServer) {
      throw new UsageError("A link to a local http server is only accepted when --server or ONETIME_SERVER names that same server.");
    }
    origin = url.origin;
    fragment = url.hash;
  } else {
    fragment = text;
  }
  const parsed = parseFragment(fragment);
  if (parsed === null || parsed === "invalid") return "invalid";
  return { origin, ...parsed };
}

// ---------- argument parsing ----------

export type GenType = "password" | "hex" | "base64url" | "uuid";

/** How send and gen get a passphrase: typed twice at the prompt, or the first line of a file. */
interface PassphraseSource {
  passphrase?: "prompt";
  passphraseFile?: string;
}

export type Command =
  | { kind: "help"; topic?: string }
  | { kind: "version" }
  | ({ kind: "send"; ttl: number; ttlExplicit?: true; server?: string; file?: string; name?: string } & PassphraseSource)
  | ({
      kind: "gen";
      type: GenType;
      length?: number;
      symbols: boolean;
      lookalikes: boolean;
      show: boolean;
      printOnly: boolean;
      ttl: number;
      server?: string;
    } & PassphraseSource)
  | { kind: "get"; link?: string; server?: string; passphraseFile?: string; output?: string }
  | { kind: "status"; link?: string; server?: string };

type OptionSpec = { value: boolean };
const OPTIONS: Record<string, Record<string, OptionSpec>> = {
  send: {
    ttl: { value: true },
    server: { value: true },
    passphrase: { value: false },
    "passphrase-file": { value: true },
    file: { value: true },
    name: { value: true },
  },
  gen: {
    type: { value: true },
    length: { value: true },
    "no-symbols": { value: false },
    "no-lookalikes": { value: false },
    show: { value: false },
    "print-only": { value: false },
    ttl: { value: true },
    server: { value: true },
    passphrase: { value: false },
    "passphrase-file": { value: true },
  },
  get: { server: { value: true }, "passphrase-file": { value: true }, output: { value: true } },
  status: { server: { value: true } },
};

const SEND_ARG_ERROR =
  "send does not take the secret as an argument: it would end up in your shell history and in the process list. " +
  "Pipe it in (echo -n 'secret' | onetime send) or run `onetime send` and type it at the hidden prompt.";

const PASSPHRASE_ARG_ERROR =
  "The passphrase is never taken as an argument: it would end up in your shell history and in the process list. " +
  "Use --passphrase (typed at a hidden prompt) or --passphrase-file PATH.";

function parseInteger(name: string, text: string, min: number, max: number, unit: string): number {
  if (!/^\d+$/.test(text) || Number(text) < min || Number(text) > max) {
    throw new UsageError(`Invalid --${name} "${text}". Use a whole number from ${min} to ${max} (${unit}).`);
  }
  return Number(text);
}

export function parseArgs(argv: string[]): Command {
  if (argv.length === 0) return { kind: "help" };
  const [first, ...rest] = argv;
  if (first === "--help" || first === "-h") return { kind: "help" };
  if (first === "--version" || first === "-V") return { kind: "version" };
  if (first === "help") {
    const topic = rest[0];
    if (topic !== undefined && !(topic in OPTIONS)) throw new UsageError(`Unknown command "${topic}".`);
    return topic === undefined ? { kind: "help" } : { kind: "help", topic };
  }
  const name = first!;
  const spec = OPTIONS[name];
  if (spec === undefined) {
    if (name.startsWith("-")) throw new UsageError(`Unknown option "${name}".`);
    throw new UsageError(`Unknown command "${name}". Run onetime --help.`);
  }

  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positional: string[] = [];
  let onlyPositional = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (onlyPositional || arg === "-" || !arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    if (arg === "--") {
      onlyPositional = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") return { kind: "help", topic: name };
    if (arg === "-o" && spec["output"] !== undefined) {
      const value = rest[++i];
      if (value === undefined) throw new UsageError("Option -o needs a value.");
      values.set("output", value);
      continue;
    }
    if (!arg.startsWith("--")) throw new UsageError(`Unknown option "${arg}".`);
    const eq = arg.indexOf("=");
    const optName = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const option = spec[optName];
    if (option === undefined) throw new UsageError(`Unknown option "--${optName}" for ${name}.`);
    if (option.value) {
      let value: string | undefined;
      if (eq !== -1) value = arg.slice(eq + 1);
      else value = rest[++i];
      if (value === undefined) throw new UsageError(`Option --${optName} needs a value.`);
      values.set(optName, value);
    } else {
      if (eq !== -1) {
        throw new UsageError(optName === "passphrase" ? PASSPHRASE_ARG_ERROR : `Option --${optName} does not take a value.`);
      }
      flags.add(optName);
    }
  }

  const server = values.get("server");
  const withServer = <T extends object>(command: T) => (server === undefined ? command : { ...command, server });
  const ttl = values.has("ttl") ? parseTtl(values.get("ttl")!) : DEFAULT_TTL_SECONDS;
  if (flags.has("passphrase") && values.has("passphrase-file")) {
    throw new UsageError("Use either --passphrase or --passphrase-file, not both.");
  }
  const passphraseFile = values.get("passphrase-file");
  const withPassphrase = <T extends object>(command: T) => ({
    ...command,
    ...(flags.has("passphrase") ? { passphrase: "prompt" as const } : {}),
    ...(passphraseFile === undefined ? {} : { passphraseFile }),
  });

  switch (name) {
    case "send":
      if (positional.length > 0) throw new UsageError(SEND_ARG_ERROR);
      if (values.has("name") && !values.has("file")) throw new UsageError("--name only applies with --file.");
      return withPassphrase(
        withServer({
          kind: "send" as const,
          ttl,
          ...(values.has("ttl") ? { ttlExplicit: true as const } : {}),
          ...(values.has("file") ? { file: values.get("file")! } : {}),
          ...(values.has("name") ? { name: values.get("name")! } : {}),
        }),
      );
    case "gen": {
      if (positional.length > 0) throw new UsageError("gen takes no arguments. Run onetime gen --help.");
      const typeText = values.get("type") ?? "password";
      if (!["password", "hex", "base64url", "uuid"].includes(typeText)) {
        throw new UsageError(`Invalid --type "${typeText}". Use password, hex, base64url or uuid.`);
      }
      const type = typeText as GenType;
      let length: number | undefined;
      if (values.has("length")) {
        if (type === "uuid") throw new UsageError("--length does not apply to --type uuid.");
        const [min, max, unit] =
          type === "password"
            ? [PASSWORD_LENGTH.min, PASSWORD_LENGTH.max, "characters"]
            : [TOKEN_BYTES.min, TOKEN_BYTES.max, "bytes"];
        length = parseInteger("length", values.get("length")!, min, max, unit);
      }
      if (type !== "password" && (flags.has("no-symbols") || flags.has("no-lookalikes"))) {
        if (flags.has("no-symbols")) throw new UsageError("--no-symbols only applies to --type password.");
        if (type !== "hex" && type !== "base64url") throw new UsageError("--no-lookalikes only applies to --type password.");
        throw new UsageError("--no-lookalikes only applies to --type password.");
      }
      if (flags.has("print-only") && flags.has("show")) {
        throw new UsageError("--show has no effect with --print-only (the secret is printed anyway).");
      }
      if (flags.has("print-only") && (flags.has("passphrase") || passphraseFile !== undefined)) {
        throw new UsageError("--passphrase and --passphrase-file do not apply to --print-only (no link is made).");
      }
      return withPassphrase(withServer({
        kind: "gen" as const,
        type,
        ...(length === undefined ? {} : { length }),
        symbols: !flags.has("no-symbols"),
        lookalikes: !flags.has("no-lookalikes"),
        show: flags.has("show"),
        printOnly: flags.has("print-only"),
        ttl,
      }));
    }
    default: {
      if (positional.length > 1) throw new UsageError(`${name} takes one link. Run onetime ${name} --help.`);
      const link = positional[0];
      const base = { kind: name as "get" | "status", ...(link === undefined ? {} : { link }) };
      if (name !== "get") return withServer(base);
      const output = values.get("output");
      return withServer({ ...base, ...(passphraseFile === undefined ? {} : { passphraseFile }), ...(output === undefined ? {} : { output }) });
    }
  }
}

// ---------- help ----------

/** Whether this build writes passphrase links (deploy 2). Until then the writer options stay out of the help. */
function writersOn(io: Pick<Io, "writeFormat">): boolean {
  return (io.writeFormat ?? WRITE_FORMAT) === 2;
}

/** Whether this build writes files (deploy F2). Until then `send --file` stays out of the help and exits 2. */
function filesOn(io: Pick<Io, "writeFiles">): boolean {
  return (io.writeFiles ?? WRITE_FILES) === true;
}

function helpMain(writers: boolean, files: boolean): string {
  return `onetime - share a secret through a link that works once

Usage:
  onetime send [--ttl 1h|1d|7d|SECONDS]${writers ? " [--passphrase | --passphrase-file PATH]" : ""} [--server URL]${files ? "\n  onetime send --file PATH|- [--name NAME] [--ttl 1h|1d]" : ""}
  onetime gen  [--type password|hex|base64url|uuid] [--length N] [--no-symbols]
               [--no-lookalikes] [--ttl ...] [--show] [--print-only]${writers ? "\n               [--passphrase | --passphrase-file PATH]" : ""} [--server URL]
  onetime get  [LINK | -] [-o PATH] [--passphrase-file PATH] [--server URL]
  onetime status [LINK | -] [--server URL]
  onetime --help | --version

Commands:
  send     Encrypt a secret (from stdin, or typed at a hidden prompt) and print the link.
  gen      Generate a secret and print a link to it. The secret itself is not shown.
  get      Open a link, print the secret (or save a file with -o), and use the link up.
  status   Say whether a link is still waiting, without using it up.

The secret is encrypted on this machine; the server only stores ciphertext and
never sees the secret or the key (the part of the link after #).

Server: https://onetimepass.pages.dev, or set ONETIME_SERVER, or pass --server.
Exit codes: 0 ok, 1 link gone (already opened or expired), 2 usage error,
            3 damaged link, 4 decryption failed, 5 network or server error,
            70 internal error.
Run onetime COMMAND --help for details.
`;
}

function helpTopic(topic: string, writers: boolean, files: boolean): string {
  switch (topic) {
    case "send":
      return `onetime send - create a one-time link for a secret

Usage: onetime send [--ttl 1h|1d|7d|SECONDS]${writers ? " [--passphrase | --passphrase-file PATH]" : ""} [--server URL]

The secret is read from stdin when piped (one trailing newline is removed),
otherwise typed at a hidden prompt. It is never accepted as an argument, because
arguments end up in shell history and the process list.

  echo -n 'hunter2' | onetime send
  onetime send --ttl 1h < secret.txt

Prints only the link on stdout; hints go to stderr.
--ttl   how long an unopened link lasts: 1h, 1d (default), 7d, or seconds (60 to 604800);
       at most 1d while the service is nearly full
${files ? FILE_SEND_HELP : ""}${writers ? PASSPHRASE_SEND_HELP : ""}`;
    case "gen":
      return `onetime gen - generate a secret and share it in one step

Usage: onetime gen [options]

  --type password|hex|base64url|uuid   kind of secret (default password)
  --length N        characters for a password (8-128, default 24),
                    bytes for hex/base64url (16-64, default 32)
  --no-symbols      password without punctuation
  --no-lookalikes   password without I l 1 O 0 o
  --ttl 1h|1d|7d|SECONDS   (default 1d)
  --show            also print the secret to stderr, labelled
  --print-only      print the secret to stdout; no link, no server contact
  --server URL
${writers ? PASSPHRASE_GEN_HELP : ""}
Prints only the link on stdout. The secret is not printed unless you ask.
`;
    case "get":
      return `onetime get - open a link and print the secret

Usage: onetime get [LINK | -] [-o PATH] [--passphrase-file PATH] [--server URL]

LINK is the full link or just ID.KEY (the server then comes from --server or
ONETIME_SERVER). With - or no argument the link is read from stdin or typed at a
hidden prompt, which keeps it out of your shell history.

A link that needs a passphrase (it looks like https://<host>/#2p.<id>.<key>) asks for it
at a hidden prompt, or reads the first line of --passphrase-file PATH. You get one try:
a wrong passphrase destroys the secret.

Opening a link uses it up: a second attempt reports it is gone.
Prints exactly the secret on stdout (a trailing newline only when stdout is a terminal).

Files (links that look like https://<host>/#2f.<id>.<key>) need version 0.3.0 or newer, and
version 0.4.0 or newer above 1 MiB (self-hosted servers can allow up to 5 MiB):
  -o PATH   a folder: the file is saved there under its (sanitised) name, never overwriting;
            another path: the file is saved as that name, which must not exist yet.
  Without -o the raw bytes go to stdout when it is redirected; on a terminal nothing is opened.
-o also writes a text secret to a new file (no newline added).
The target is checked before the link is used up.
Exit codes: 0 ok, 1 gone, 2 usage error (including a missing passphrase, an existing target, a file link
            on a terminal without -o), 3 damaged link,
            4 decryption failed (also: wrong passphrase), 5 network or server error.
`;
    default:
      return `onetime status - check a link without using it up

Usage: onetime status [LINK | -] [--server URL]

Exit 0 if the secret is still waiting, 1 if it is gone (opened or expired).
`;
  }
}

const FILE_SEND_HELP = `
Files:
  onetime send --file PATH [--name NAME] [--ttl 1h|1d]
  cat photo.jpg | onetime send --file - --name photo.jpg
Sends a file (name and content are encrypted); it can be downloaded once. --file - reads raw bytes from a pipe.
The size limit and the longest life come from the server (GET /api/limits); on the hosted service they are
${formatBytes(HOSTED_LIMITS.maxFileBytes)} and 1 hour. Without --ttl a file lasts as long as the server allows, up to 1 day.
A file is checked against the limit before anything is uploaded. The service cannot scan files for viruses.
`;

const PASSPHRASE_SEND_HELP = `
Passphrase (optional):
  --passphrase             asks twice at a hidden prompt (needs a terminal, so not with a piped secret)
  --passphrase-file PATH   first line of PATH (at most 4096 bytes, UTF-8), for scripts
The passphrase has 8 to 256 characters. Send it to the recipient by another channel than the link:
a wrong passphrase destroys the secret, and there is one try.
`;

const PASSPHRASE_GEN_HELP = `  --passphrase      protect the link with a passphrase typed twice at a hidden prompt
  --passphrase-file PATH   same, taken from the first line of PATH (not with --print-only)
`;

// ---------- flows ----------

class ExitError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function cleanMessage(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 200);
}

async function request(io: Io, url: string, init: RequestInit): Promise<Response> {
  try {
    return await io.fetch(url, { ...init, signal: AbortSignal.timeout(20_000), redirect: "manual" });
  } catch {
    throw new ExitError(EXIT.network, "Could not reach the server. Check your connection and the server address.");
  }
}

async function serverError(response: Response): Promise<ExitError> {
  let detail = "";
  try {
    const body = (await readJson(response)) as { error?: unknown; maxTtl?: unknown };
    if (
      response.status === 409 &&
      typeof body.maxTtl === "number" &&
      Number.isSafeInteger(body.maxTtl) &&
      body.maxTtl >= MIN_TTL_SECONDS &&
      body.maxTtl <= MAX_TTL_SECONDS
    ) {
      return new ExitError(
        EXIT.network,
        `The service is nearly full right now, so links can last at most ${describeTtl(body.maxTtl)}. Run the command again with --ttl ${ttlFlag(body.maxTtl)} or shorter.`,
      );
    }
    if (typeof body.error === "string") detail = `: ${cleanMessage(body.error)}`;
  } catch {
    // not JSON
  }
  return new ExitError(EXIT.network, `The server answered ${response.status}${detail}`);
}

/** The --ttl value for a number of seconds: the preset name when there is one. */
function ttlFlag(seconds: number): string {
  for (const [name, value] of Object.entries(TTL_PRESETS)) if (value === seconds) return name;
  return String(seconds);
}

const GONE_MESSAGE = "This secret was already opened or has expired.";

async function readStdinText(io: Io): Promise<string> {
  const bytes = await io.stdin.readBytes(MAX_INPUT_BYTES);
  if (bytes.length > MAX_INPUT_BYTES) throw new UsageError(`The input is too large (limit ${MAX_SECRET_BYTES} bytes of text).`);
  return decodeInput(bytes);
}

async function readBounded(response: Response, max: number): Promise<Uint8Array> {
  const declared = response.headers.get("Content-Length");
  if (declared !== null && Number(declared) > max) throw new ExitError(EXIT.network, "The server's answer is too large.");
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new ExitError(EXIT.network, "The server's answer is too large.");
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

async function readJson(response: Response): Promise<unknown> {
  return JSON.parse(new TextDecoder().decode(await readBounded(response, MAX_JSON_BYTES)));
}

async function readSecretInput(io: Io): Promise<string> {
  let text: string;
  if (io.stdin.isTTY) text = await io.promptHidden("Secret (input hidden): ");
  else text = stripOneNewline(await readStdinText(io));
  if (text === "") throw new UsageError("The secret is empty.");
  return text;
}

async function readLinkInput(io: Io, link: string | undefined): Promise<{ text: string; fromArg: boolean }> {
  if (link !== undefined && link !== "-") return { text: link, fromArg: true };
  if (io.stdin.isTTY) return { text: await io.promptHidden("Link (input hidden): "), fromArg: false };
  return { text: await readStdinText(io), fromArg: false };
}

function codecFor(io: Io) {
  return createCodec({
    ...(io.pbkdf2Iterations === undefined ? {} : { pbkdf2Iterations: io.pbkdf2Iterations }),
    ...(io.writeFormat === undefined ? {} : { writeFormat: io.writeFormat }),
    ...(io.writeFiles === undefined ? {} : { writeFiles: io.writeFiles }),
  });
}

const PASSPHRASE_FILE_MAX = 4096;

function passphraseProblem(text: string): string | null {
  switch (validatePassphrase(text)) {
    case null:
      return null;
    case "control":
      return "A passphrase cannot contain control characters.";
    default:
      return "A passphrase has 8 to 256 characters.";
  }
}

function checkPassphrase(text: string): string {
  const problem = passphraseProblem(text);
  if (problem !== null) throw new UsageError(problem);
  return text;
}

/** First line of the file (strict UTF-8, at most 4,096 bytes); a trailing CR or LF is not part of the passphrase. */
async function readPassphraseFile(io: Io, path: string): Promise<string> {
  let bytes: Uint8Array;
  try {
    bytes = await io.readFile(path, PASSPHRASE_FILE_MAX);
  } catch {
    throw new UsageError("Could not read the passphrase file.");
  }
  if (bytes.length > PASSPHRASE_FILE_MAX) throw new UsageError(`The passphrase file is larger than ${PASSPHRASE_FILE_MAX} bytes.`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new UsageError("The passphrase file is not valid UTF-8 text.");
  }
  const newline = text.indexOf("\n");
  const line = newline === -1 ? text : text.slice(0, newline);
  return checkPassphrase(line.endsWith("\r") ? line.slice(0, -1) : line);
}

type PassphraseOption = { passphrase?: "prompt"; passphraseFile?: string };

/** Refuses what cannot work before anything is read, prompted or sent. */
function checkPassphraseOptions(io: Io, command: PassphraseOption, secretIsPiped: boolean): void {
  if (command.passphrase === undefined && command.passphraseFile === undefined) return;
  if (!writersOn(io)) throw new UsageError("Passphrases are not available yet.");
  if (command.passphrase !== undefined && !io.stdin.isTTY) {
    throw new UsageError(
      secretIsPiped
        ? "--passphrase asks at the terminal, which the piped secret is using: use --passphrase-file when the secret is piped."
        : "--passphrase needs a terminal: use --passphrase-file PATH instead.",
    );
  }
}

/** The passphrase for a new link, or undefined when none was asked for. Typed entries must match. */
async function readNewPassphrase(io: Io, command: PassphraseOption): Promise<string | undefined> {
  if (command.passphraseFile !== undefined) return readPassphraseFile(io, command.passphraseFile);
  if (command.passphrase === undefined) return undefined;
  const first = await io.promptHidden("Passphrase (input hidden): ");
  const second = await io.promptHidden("Repeat passphrase: ");
  if (normalizePassphrase(first) !== normalizePassphrase(second)) throw new UsageError("The two passphrases differ.");
  return checkPassphrase(first);
}

/** Posts a blob and returns the validated id. */
async function uploadBlob(io: Io, blob: Uint8Array<ArrayBuffer>, ttl: number, server: string, isFile: boolean): Promise<string> {
  const response = await request(io, `${server}/api/secrets?ttl=${ttl}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: blob,
  });
  if (!response.ok) {
    if (isFile && response.status === 413) throw new ExitError(EXIT.network, "The server does not accept files this large.");
    if (isFile && response.status === 503) {
      throw new ExitError(EXIT.network, "There is no room for files right now. Try again later or send a smaller file.");
    }
    throw await serverError(response);
  }
  let id: unknown;
  try {
    id = ((await readJson(response)) as { id?: unknown }).id;
  } catch {
    throw new ExitError(EXIT.network, "The server's answer was not understood.");
  }
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new ExitError(EXIT.network, "The server returned an invalid secret id.");
  }
  return id;
}

async function createLink(io: Io, text: string, ttl: number, server: string, passphrase?: string): Promise<string> {
  let encrypted;
  try {
    encrypted = await codecFor(io).encryptSecret(text, passphrase);
  } catch (error) {
    if (error instanceof SecretTooLargeError) {
      throw new UsageError(`The secret is too large (limit ${MAX_SECRET_BYTES} bytes).`);
    }
    throw error;
  }
  const id = await uploadBlob(io, encrypted.blob, ttl, server, false);
  return buildLink(server, { id, key: encrypted.key, format: encrypted.format, passphrase: encrypted.passphrase, file: false });
}

/**
 * The server's file limits from GET /api/limits. Anything that is not a valid answer (404 or 405 from an older server,
 * a redirect, an error, HTML, nonsense, a reply above 1 KiB, no connection) gives the hosted limits: the upload that
 * follows then reports a real network problem, and a server that refuses the file says so.
 */
async function serverLimits(io: Io, server: string): Promise<ServerLimits> {
  try {
    const response = await io.fetch(`${server}/api/limits`, { method: "GET", signal: AbortSignal.timeout(10_000), redirect: "manual" });
    if (!response.ok) return HOSTED_LIMITS;
    const body = await readBounded(response, 1024);
    return parseLimits(JSON.parse(new TextDecoder().decode(body))) ?? HOSTED_LIMITS;
  } catch {
    return HOSTED_LIMITS;
  }
}

async function createFileLink(io: Io, file: { name: string; bytes: Uint8Array }, ttl: number, server: string, passphrase?: string): Promise<string> {
  let encrypted;
  try {
    encrypted = await codecFor(io).encryptFile({ name: file.name, type: "", bytes: file.bytes }, passphrase);
  } catch (error) {
    if (error instanceof SecretTooLargeError) {
      throw new UsageError(`The file is too large for the blob format (limit ${formatBytes(FORMAT_MAX_FILE_BYTES)}).`);
    }
    throw error;
  }
  const id = await uploadBlob(io, encrypted.blob, ttl, server, true);
  return buildLink(server, { id, key: encrypted.key, format: 2, passphrase: encrypted.passphrase, file: true });
}

/** The file for `send --file`: raw bytes from a path or a pipe, with a sanitised name. Refuses empty and oversized input. */
async function readFileInput(io: Io, path: string, nameOverride: string | undefined, limit: number): Promise<{ name: string; bytes: Uint8Array }> {
  let bytes: Uint8Array;
  if (path === "-") {
    if (io.stdin.isTTY) throw new UsageError("Pipe the file in, or give a path.");
    bytes = await io.stdin.readBytes(limit);
  } else {
    try {
      bytes = await io.readFile(path, limit);
    } catch {
      throw new UsageError("Could not read the file.");
    }
  }
  if (bytes.length === 0) throw new UsageError("The file is empty.");
  if (bytes.length > limit) throw new UsageError(`The file is too large (limit ${formatBytes(limit)}).`);
  return { name: safeFileName(nameOverride ?? (path === "-" ? "" : path)), bytes };
}

function sendHints(io: Io, ttl: number, passphrase: boolean, file?: { name: string; size: number; maxTtl: number }): void {
  io.stderr.write(
    (file === undefined ? "" : `File: ${file.name} (${formatBytes(file.size)}). Files last at most ${describeTtl(file.maxTtl)}.\n`) +
      `Opens once. Expires in ${describeTtl(ttl)} if not opened.\n` +
      (file === undefined
        ? "Receive it in a browser, or with: onetime get -  (then paste the link)\n"
        : "Receive it with: onetime get - -o FOLDER  (then paste the link)\n") +
      (passphrase ? "Send the passphrase separately. A wrong one destroys the secret.\n" : ""),
  );
}

function generateSecret(command: Extract<Command, { kind: "gen" }>): string {
  switch (command.type) {
    case "uuid":
      return generateUuid();
    case "hex":
    case "base64url":
      return generateToken(command.length ?? TOKEN_BYTES.default, command.type);
    default: {
      const sets: CharsetName[] = ["lower", "upper", "digits"];
      if (command.symbols) sets.push("symbols");
      return generatePassword({
        length: command.length ?? PASSWORD_LENGTH.default,
        sets,
        avoidLookalikes: !command.lookalikes,
      });
    }
  }
}

// ---------- where `get` puts what it opens ----------

type Target = { kind: "stdout" } | { kind: "file"; path: string } | { kind: "dir"; path: string };

/** The folder part of a path, without node:path (the core also runs in tests without it). */
function parentOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (cut === -1) return ".";
  return cut === 0 ? path.slice(0, 1) : path.slice(0, cut);
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") || dir.endsWith("\\") ? `${dir}${name}` : `${dir}/${name}`;
}

/**
 * Decides and checks the destination before anything is requested. A file link without -o on a terminal is refused
 * (nothing is opened); an existing target, or a folder that is missing, is refused too.
 */
async function planOutput(io: Io, output: string | undefined, isFile: boolean): Promise<Target> {
  if (output === undefined) {
    if (isFile && io.stdout.isTTY) {
      throw new UsageError("This link holds a file. Save it with -o <file or directory>, or redirect the output.");
    }
    return { kind: "stdout" };
  }
  const kind = await io.stat(output);
  if (kind === "dir") {
    if (!isFile) throw new UsageError("-o must be a file name for a text secret, not a folder.");
    return { kind: "dir", path: output };
  }
  if (kind === "file") throw new UsageError(`${output} already exists; nothing was opened.`);
  if ((await io.stat(parentOf(output))) !== "dir") {
    throw new UsageError(`The folder for ${output} does not exist; nothing was opened.`);
  }
  return { kind: "file", path: output };
}

const WRITE_FAILED = "Could not write the file. It is now used up.";

/** Creates `path` exclusively. Removes what this call created if the write fails; returns false only when the path already exists. */
async function tryCreate(io: Io, path: string, bytes: Uint8Array, failure: string = WRITE_FAILED): Promise<boolean> {
  try {
    await io.writeFileExclusive(path, bytes);
    return true;
  } catch (error) {
    const e = error as { code?: unknown; partial?: unknown };
    if (e.code === "EEXIST") return false;
    if (e.partial === true) await io.removeFile(path).catch(() => {});
    throw new ExitError(EXIT.network, failure);
  }
}

/** A new file at `path`; it must not exist (a file that appeared since the check is never overwritten or removed). */
async function saveNew(io: Io, path: string, bytes: Uint8Array, failure: string): Promise<void> {
  if (!(await tryCreate(io, path, bytes, failure))) throw new ExitError(EXIT.network, failure);
}

const EXTENSION = /\.[A-Za-z0-9]{1,16}$/;

/** `name`, then `stem (1).ext` to `(99)`, then onetime-<8 hex>.bin. */
function* candidateNames(name: string): Generator<string> {
  yield name;
  const ext = EXTENSION.exec(name)?.[0] ?? "";
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i <= 99; i++) yield `${stem} (${i})${ext}`;
  const random = crypto.getRandomValues(new Uint8Array(4));
  yield `onetime-${[...random].map((b) => b.toString(16).padStart(2, "0")).join("")}.bin`;
}

async function deliverFile(io: Io, target: Target, file: { name: string; bytes: Uint8Array }): Promise<void> {
  if (target.kind === "stdout") {
    try {
      await io.stdout.writeBytes(file.bytes);
    } catch {
      throw new ExitError(EXIT.network, "Could not write the file to the output. It is now used up.");
    }
    return;
  }
  let path: string | undefined;
  if (target.kind === "file") {
    if (!(await tryCreate(io, target.path, file.bytes))) throw new ExitError(EXIT.network, WRITE_FAILED);
    path = target.path;
  } else {
    for (const candidate of candidateNames(file.name)) {
      // Defence in depth: a safe name has no separator, but nothing may ever leave the folder.
      if (/[\\/]/.test(candidate) || candidate === "." || candidate === "..") continue;
      const candidatePath = joinPath(target.path, candidate);
      if (await tryCreate(io, candidatePath, file.bytes)) {
        path = candidatePath;
        break;
      }
    }
    if (path === undefined) throw new ExitError(EXIT.network, WRITE_FAILED);
  }
  const saved = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  io.stderr.write(
    `Saved ${target.kind === "dir" ? saved : file.name} (${formatBytes(file.bytes.length)}) to ${path}.\n` +
      (riskyFile(file.name)
        ? "Warning: this kind of file can run code on your device. Open it only if you expected it from the sender.\n"
        : ""),
  );
}

async function execute(command: Command, io: Io): Promise<number> {
  switch (command.kind) {
    case "help":
      io.stdout.write(command.topic ? helpTopic(command.topic, writersOn(io), filesOn(io)) : helpMain(writersOn(io), filesOn(io)));
      return EXIT.ok;
    case "version":
      io.stdout.write(`${io.version}\n`);
      return EXIT.ok;
    case "send": {
      if (command.file !== undefined) {
        if (!filesOn(io)) throw new UsageError("Sending files is not available yet.");
        const server = resolveServer(command.server, io.env, io.defaultServer);
        checkPassphraseOptions(io, command, command.file === "-");
        if (command.file === "-" && io.stdin.isTTY) throw new UsageError("Pipe the file in, or give a path.");
        // The server's limits decide, and they are known before the file is read or anything is uploaded.
        const limits = await serverLimits(io, server);
        if (limits.maxFileBytes === 0) throw new UsageError("This server does not accept files.");
        if (command.ttlExplicit === true && command.ttl > limits.maxFileTtl) {
          throw new UsageError(`Files can last at most ${describeTtl(limits.maxFileTtl)} on this server.`);
        }
        const ttl = Math.min(command.ttl, limits.maxFileTtl);
        const file = await readFileInput(io, command.file, command.name, limits.maxFileBytes);
        const passphrase = await readNewPassphrase(io, command);
        const link = await createFileLink(io, file, ttl, server, passphrase);
        io.stdout.write(`${link}\n`);
        sendHints(io, ttl, passphrase !== undefined, { name: file.name, size: file.bytes.length, maxTtl: limits.maxFileTtl });
        return EXIT.ok;
      }
      const server = resolveServer(command.server, io.env, io.defaultServer);
      checkPassphraseOptions(io, command, !io.stdin.isTTY);
      const secret = await readSecretInput(io);
      const passphrase = await readNewPassphrase(io, command);
      const link = await createLink(io, secret, command.ttl, server, passphrase);
      io.stdout.write(`${link}\n`);
      sendHints(io, command.ttl, passphrase !== undefined);
      return EXIT.ok;
    }
    case "gen": {
      const secret = generateSecret(command);
      if (command.printOnly) {
        io.stdout.write(`${secret}\n`);
        return EXIT.ok;
      }
      const server = resolveServer(command.server, io.env, io.defaultServer);
      checkPassphraseOptions(io, command, false);
      const passphrase = await readNewPassphrase(io, command);
      const link = await createLink(io, secret, command.ttl, server, passphrase);
      io.stdout.write(`${link}\n`);
      if (command.show) io.stderr.write(`Secret: ${secret}\n`);
      sendHints(io, command.ttl, passphrase !== undefined);
      return EXIT.ok;
    }
    case "get":
    case "status": {
      const defaultServer = resolveServer(command.server, io.env, io.defaultServer);
      const explicitText = command.server ?? (io.env.ONETIME_SERVER ? io.env.ONETIME_SERVER : undefined);
      const explicit = explicitText === undefined ? undefined : defaultServer;
      const input = await readLinkInput(io, command.link);
      const parsed = parseLinkInput(input.text, defaultServer, explicit);
      if (parsed === "invalid") {
        const shape = writersOn(io) ? "https://<host>/#2.<id>.<key>" : "https://<host>/#<id>.<key>";
        throw new ExitError(EXIT.badLink, `The link is damaged or incomplete. It should look like ${shape}.`);
      }
      if (command.kind === "status") {
        const response = await request(io, `${parsed.origin}/api/secrets/${parsed.id}`, { method: "GET" });
        if (response.ok) {
          const what = parsed.file ? "The file" : "The secret";
          io.stderr.write(parsed.passphrase ? `${what} is still waiting (it needs a passphrase).\n` : `${what} is still waiting.\n`);
          return EXIT.ok;
        }
        if (response.status === 404) {
          io.stderr.write(`${GONE_MESSAGE}\n`);
          return EXIT.gone;
        }
        throw await serverError(response);
      }
      // Where the result goes is decided and checked before the link is used up.
      const target = await planOutput(io, command.output, parsed.file);
      let passphrase: string | undefined;
      if (parsed.passphrase) {
        if (command.passphraseFile !== undefined) passphrase = await readPassphraseFile(io, command.passphraseFile);
        else if (io.stdin.isTTY) passphrase = checkPassphrase(await io.promptHidden("Passphrase (input hidden, one try): "));
        else throw new UsageError("This link needs a passphrase: run it in a terminal or use --passphrase-file.");
      } else if (command.passphraseFile !== undefined) {
        throw new UsageError("This link has no passphrase.");
      }
      // The slow step runs before the reveal request, so closing the terminal here loses nothing.
      const codec = codecFor(io);
      const aesKey = await codec.deriveKey(parsed, passphrase);
      if (input.fromArg) {
        io.stderr.write(
          "Note: the link is now in your shell history. Next time use `onetime get -` or `onetime get` and paste it.\n",
        );
      }
      const response = await request(io, `${parsed.origin}/api/secrets/${parsed.id}/reveal`, { method: "POST" });
      if (response.status === 404) throw new ExitError(EXIT.gone, GONE_MESSAGE);
      if (!response.ok) throw await serverError(response);
      const blob = await readBounded(response, FORMAT_MAX_BLOB_BYTES);
      let opened;
      try {
        opened = await codec.openPayload(blob as Uint8Array<ArrayBuffer>, aesKey, parsed);
      } catch {
        throw new ExitError(
          EXIT.decrypt,
          parsed.passphrase
            ? "Decryption failed: wrong passphrase, or the link was changed. The secret is now used up."
            : "Decryption failed: the key does not match or the data was changed. The secret is now used up.",
        );
      }
      if (opened.kind === "file") {
        await deliverFile(io, target, opened);
        return EXIT.ok;
      }
      if (target.kind === "file") {
        const bytes = new TextEncoder().encode(opened.text);
        await saveNew(io, target.path, bytes, "Could not write the secret to the file. It is now used up.");
        io.stderr.write(`Saved the secret (${formatBytes(bytes.length)}) to ${target.path}.\n`);
        return EXIT.ok;
      }
      try {
        await io.stdout.write(io.stdout.isTTY ? `${opened.text}\n` : opened.text);
      } catch {
        throw new ExitError(EXIT.network, "Could not write the secret to the output. It is now used up.");
      }
      return EXIT.ok;
    }
  }
}

/** Runs one CLI invocation and returns the exit code. Never throws. */
export async function run(argv: string[], io: Io): Promise<number> {
  try {
    return await execute(parseArgs(argv), io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`onetime: ${error.message}\n`);
      return EXIT.usage;
    }
    if (error instanceof ExitError) {
      io.stderr.write(`onetime: ${error.message}\n`);
      return error.code;
    }
    io.stderr.write("onetime: unexpected internal error.\n");
    return EXIT.internal;
  }
}
