import { decryptSecret, encryptSecret, SecretTooLargeError } from "../src/web/crypto";
import {
  generatePassword,
  generateToken,
  generateUuid,
  PASSWORD_LENGTH,
  TOKEN_BYTES,
  type CharsetName,
} from "../src/web/generate";
import { buildLink, parseFragment } from "../src/web/link";
import { DEFAULT_TTL_SECONDS, MAX_SECRET_BYTES, MAX_TTL_SECONDS, MIN_TTL_SECONDS } from "../src/shared/limits";

export const DEFAULT_SERVER = "https://onetimepass.pages.dev";

export const EXIT = { ok: 0, gone: 1, usage: 2, badLink: 3, decrypt: 4, network: 5, interrupted: 130 } as const;

export class UsageError extends Error {}

/** Everything the core needs from the outside world, so tests can inject it. */
export interface Io {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  version: string;
  stdin: { isTTY: boolean; readAll(): Promise<string> };
  promptHidden(label: string): Promise<string>;
  stdout: { isTTY: boolean; write(text: string): void };
  stderr: { write(text: string): void };
}

// ---------- small helpers ----------

/** Strips exactly one trailing newline (LF or CRLF), as `echo` and PowerShell add one. */
export function stripOneNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
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
export function resolveServer(flag: string | undefined, env: Record<string, string | undefined>): string {
  const text = flag ?? (env.ONETIME_SERVER ? env.ONETIME_SERVER : DEFAULT_SERVER);
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

export interface ParsedLink {
  origin: string;
  id: string;
  key: string;
}

/** Accepts a full link or `<id>.<key>`. Returns "invalid" without ever echoing the input. */
export function parseLinkInput(input: string, defaultOrigin: string): ParsedLink | "invalid" {
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

export type Command =
  | { kind: "help"; topic?: string }
  | { kind: "version" }
  | { kind: "send"; ttl: number; server?: string }
  | {
      kind: "gen";
      type: GenType;
      length?: number;
      symbols: boolean;
      lookalikes: boolean;
      show: boolean;
      printOnly: boolean;
      ttl: number;
      server?: string;
    }
  | { kind: "get"; link?: string; server?: string }
  | { kind: "status"; link?: string; server?: string };

type OptionSpec = { value: boolean };
const OPTIONS: Record<string, Record<string, OptionSpec>> = {
  send: { ttl: { value: true }, server: { value: true } },
  gen: {
    type: { value: true },
    length: { value: true },
    "no-symbols": { value: false },
    "no-lookalikes": { value: false },
    show: { value: false },
    "print-only": { value: false },
    ttl: { value: true },
    server: { value: true },
  },
  get: { server: { value: true } },
  status: { server: { value: true } },
};

const SEND_ARG_ERROR =
  "send does not take the secret as an argument: it would end up in your shell history and in the process list. " +
  "Pipe it in (echo -n 'secret' | onetime send) or run `onetime send` and type it at the hidden prompt.";

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
      if (eq !== -1) throw new UsageError(`Option --${optName} does not take a value.`);
      flags.add(optName);
    }
  }

  const server = values.get("server");
  const withServer = <T extends object>(command: T) => (server === undefined ? command : { ...command, server });
  const ttl = values.has("ttl") ? parseTtl(values.get("ttl")!) : DEFAULT_TTL_SECONDS;

  switch (name) {
    case "send":
      if (positional.length > 0) throw new UsageError(SEND_ARG_ERROR);
      return withServer({ kind: "send" as const, ttl });
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
      return withServer({
        kind: "gen" as const,
        type,
        ...(length === undefined ? {} : { length }),
        symbols: !flags.has("no-symbols"),
        lookalikes: !flags.has("no-lookalikes"),
        show: flags.has("show"),
        printOnly: flags.has("print-only"),
        ttl,
      });
    }
    default: {
      if (positional.length > 1) throw new UsageError(`${name} takes one link. Run onetime ${name} --help.`);
      const link = positional[0];
      return withServer({ kind: name as "get" | "status", ...(link === undefined ? {} : { link }) });
    }
  }
}

// ---------- help ----------

const HELP_MAIN = `onetime - share a secret through a link that works once

Usage:
  onetime send [--ttl 1h|1d|7d|SECONDS] [--server URL]
  onetime gen  [--type password|hex|base64url|uuid] [--length N] [--no-symbols]
               [--no-lookalikes] [--ttl ...] [--show] [--print-only] [--server URL]
  onetime get  [LINK | -] [--server URL]
  onetime status [LINK | -] [--server URL]
  onetime --help | --version

Commands:
  send     Encrypt a secret (from stdin, or typed at a hidden prompt) and print the link.
  gen      Generate a secret and print a link to it. The secret itself is not shown.
  get      Open a link, print the secret, and use the link up.
  status   Say whether a link is still waiting, without using it up.

The secret is encrypted on this machine; the server only stores ciphertext and
never sees the secret or the key (the part of the link after #).

Server: https://onetimepass.pages.dev, or set ONETIME_SERVER, or pass --server.
Exit codes: 0 ok, 1 link gone (already opened or expired), 2 usage error,
            3 damaged link, 4 decryption failed, 5 network or server error.
Run onetime COMMAND --help for details.
`;

const HELP_TOPICS: Record<string, string> = {
  send: `onetime send - create a one-time link for a secret

Usage: onetime send [--ttl 1h|1d|7d|SECONDS] [--server URL]

The secret is read from stdin when piped (one trailing newline is removed),
otherwise typed at a hidden prompt. It is never accepted as an argument, because
arguments end up in shell history and the process list.

  echo -n 'hunter2' | onetime send
  onetime send --ttl 1h < secret.txt

Prints only the link on stdout; hints go to stderr.
--ttl   how long an unopened link lasts: 1h, 1d (default), 7d, or seconds (60 to 604800)
`,
  gen: `onetime gen - generate a secret and share it in one step

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

Prints only the link on stdout. The secret is not printed unless you ask.
`,
  get: `onetime get - open a link and print the secret

Usage: onetime get [LINK | -] [--server URL]

LINK is the full link or just ID.KEY (the server then comes from --server or
ONETIME_SERVER). With - or no argument the link is read from stdin or typed at a
hidden prompt, which keeps it out of your shell history.

Opening a link uses it up: a second attempt reports it is gone.
Prints exactly the secret on stdout (a trailing newline only when stdout is a terminal).
Exit codes: 0 ok, 1 gone, 3 damaged link, 4 decryption failed, 5 network or server error.
`,
  status: `onetime status - check a link without using it up

Usage: onetime status [LINK | -] [--server URL]

Exit 0 if the secret is still waiting, 1 if it is gone (opened or expired).
`,
};

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
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") detail = `: ${cleanMessage(body.error)}`;
  } catch {
    // not JSON
  }
  return new ExitError(EXIT.network, `The server answered ${response.status}${detail}`);
}

const GONE_MESSAGE = "This secret was already opened or has expired.";

async function readSecretInput(io: Io): Promise<string> {
  let text: string;
  if (io.stdin.isTTY) text = await io.promptHidden("Secret (input hidden): ");
  else text = stripOneNewline(await io.stdin.readAll());
  if (text === "") throw new UsageError("The secret is empty.");
  return text;
}

async function readLinkInput(io: Io, link: string | undefined): Promise<{ text: string; fromArg: boolean }> {
  if (link !== undefined && link !== "-") return { text: link, fromArg: true };
  if (io.stdin.isTTY) return { text: await io.promptHidden("Link (input hidden): "), fromArg: false };
  return { text: await io.stdin.readAll(), fromArg: false };
}

async function createLink(io: Io, text: string, ttl: number, server: string): Promise<string> {
  let encrypted;
  try {
    encrypted = await encryptSecret(text);
  } catch (error) {
    if (error instanceof SecretTooLargeError) {
      throw new UsageError(`The secret is too large (limit ${MAX_SECRET_BYTES} bytes).`);
    }
    throw error;
  }
  const response = await request(io, `${server}/api/secrets?ttl=${ttl}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: encrypted.blob,
  });
  if (!response.ok) throw await serverError(response);
  const { id } = (await response.json()) as { id: string };
  return buildLink(server, { id, key: encrypted.key });
}

function sendHints(io: Io, link: string, ttl: number): void {
  io.stderr.write(
    `Opens once. Expires in ${describeTtl(ttl)} if not opened.\n` +
      `Receive with: onetime get "${link}"  (or open it in a browser)\n`,
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

async function execute(command: Command, io: Io): Promise<number> {
  switch (command.kind) {
    case "help":
      io.stdout.write(command.topic ? HELP_TOPICS[command.topic]! : HELP_MAIN);
      return EXIT.ok;
    case "version":
      io.stdout.write(`${io.version}\n`);
      return EXIT.ok;
    case "send": {
      const server = resolveServer(command.server, io.env);
      const secret = await readSecretInput(io);
      const link = await createLink(io, secret, command.ttl, server);
      io.stdout.write(`${link}\n`);
      sendHints(io, link, command.ttl);
      return EXIT.ok;
    }
    case "gen": {
      const secret = generateSecret(command);
      if (command.printOnly) {
        io.stdout.write(`${secret}\n`);
        return EXIT.ok;
      }
      const server = resolveServer(command.server, io.env);
      const link = await createLink(io, secret, command.ttl, server);
      io.stdout.write(`${link}\n`);
      if (command.show) io.stderr.write(`Secret: ${secret}\n`);
      sendHints(io, link, command.ttl);
      return EXIT.ok;
    }
    case "get":
    case "status": {
      const defaultServer = resolveServer(command.server, io.env);
      const input = await readLinkInput(io, command.link);
      const parsed = parseLinkInput(input.text, defaultServer);
      if (parsed === "invalid") {
        throw new ExitError(EXIT.badLink, "The link is damaged or incomplete. It should look like https://<host>/#<id>.<key>.");
      }
      if (command.kind === "status") {
        const response = await request(io, `${parsed.origin}/api/secrets/${parsed.id}`, { method: "GET" });
        if (response.ok) {
          io.stderr.write("The secret is still waiting.\n");
          return EXIT.ok;
        }
        if (response.status === 404) {
          io.stderr.write(`${GONE_MESSAGE}\n`);
          return EXIT.gone;
        }
        throw await serverError(response);
      }
      if (input.fromArg) {
        io.stderr.write(
          "Note: the link is now in your shell history. Next time use `onetime get -` or `onetime get` and paste it.\n",
        );
      }
      const response = await request(io, `${parsed.origin}/api/secrets/${parsed.id}/reveal`, { method: "POST" });
      if (response.status === 404) throw new ExitError(EXIT.gone, GONE_MESSAGE);
      if (!response.ok) throw await serverError(response);
      const blob = new Uint8Array(await response.arrayBuffer());
      let secret: string;
      try {
        secret = await decryptSecret(blob, parsed.key);
      } catch {
        throw new ExitError(EXIT.decrypt, "Decryption failed: the key does not match or the data was changed. The secret is now used up.");
      }
      io.stdout.write(io.stdout.isTTY ? `${secret}\n` : secret);
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
    io.stderr.write("onetime: unexpected error.\n");
    return EXIT.network;
  }
}
