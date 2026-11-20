import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { headersFor, HeadersFileError, parseHeaders, type HeaderRules } from "./headers";

export class SiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiteError";
  }
}

export interface StaticResult {
  status: number;
  headers: [string, string][];
  body: Uint8Array | null;
}

export interface Site {
  /** Answers a request target (path and optional query) from the in-memory table. Never touches the filesystem. */
  resolve(target: string, method: string, ifNoneMatch?: string): StaticResult;
  /** The origin this build was made for (from `_selfhost.json`). */
  readonly origin: string;
  readonly fileCount: number;
}

interface Entry {
  body: Uint8Array;
  type: string;
  etag: string;
}

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "application/javascript",
  mjs: "application/javascript",
  css: "text/css; charset=utf-8",
  json: "application/json",
  webmanifest: "application/manifest+json",
  svg: "image/svg+xml",
  png: "image/png",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml",
};

const contentType = (name: string) => TYPES[name.slice(name.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";

/** Reads every file under `dir` into memory. Symlinks anywhere refuse the start. Returns paths like `/assets/a.js`. */
function walk(dir: string, prefix = ""): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const path = `${prefix}/${name}`;
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) throw new SiteError(`${full} is a symlink; symlinks in the site folder are not allowed`);
    if (stat.isDirectory()) {
      for (const [p, body] of walk(full, path)) files.set(p, body);
    } else if (stat.isFile()) {
      files.set(path, readFileSync(full));
    }
  }
  return files;
}

function readOrigin(files: Map<string, Uint8Array>, dir: string): string {
  const raw = files.get("/_selfhost.json");
  if (raw === undefined) {
    throw new SiteError(`${dir} has no _selfhost.json: it is not a self-host build (run "pnpm build:selfhost"; the Pages build must not be served by this server)`);
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as { origin?: unknown };
    if (typeof parsed.origin === "string" && parsed.origin !== "") return parsed.origin;
  } catch {
    // falls through
  }
  throw new SiteError(`${dir}/_selfhost.json is invalid: it needs a non-empty "origin" string`);
}

/** A name that must never be served, except /.well-known/security.txt: anything starting with "_" at the root, or any dot-segment name. */
function hidden(path: string): boolean {
  if (path === "/.well-known/security.txt") return false; // the one dot path served (RFC 9116)
  return path.slice(1).startsWith("_") || path.split("/").some((segment) => segment.startsWith("."));
}

function etagOf(body: Uint8Array): string {
  return `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`;
}

type Decoded = { ok: true; raw: string; path: string; query: string } | { ok: false };

/** Splits and decodes a request target, refusing what Pages refuses (400). Looks at the raw text, because URL parsing would resolve `..`. */
function decodeTarget(target: string): Decoded {
  if (!target.startsWith("/")) return { ok: false };
  const cut = target.search(/[?#]/);
  const raw = cut === -1 ? target : target.slice(0, cut);
  const query = cut !== -1 && target[cut] === "?" ? target.slice(cut).split("#")[0]! : "";
  let path: string;
  try {
    path = decodeURIComponent(raw);
  } catch {
    return { ok: false };
  }
  if (path.includes("\0") || path.includes("\\") || path.includes("\n") || path.includes("\r")) return { ok: false };
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return { ok: false };
  return { ok: true, raw, path, query };
}

export function loadSite(dir: string): Site {
  let files: Map<string, Uint8Array>;
  try {
    if (!lstatSync(dir).isDirectory()) throw new SiteError(`${dir} is not a directory`);
    files = walk(dir);
  } catch (error) {
    if (error instanceof SiteError) throw error;
    throw new SiteError(`cannot read the site folder ${dir}: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
  }

  const origin = readOrigin(files, dir);
  const headersFile = files.get("/_headers");
  if (headersFile === undefined) throw new SiteError(`${dir} has no _headers file`);
  let rules: HeaderRules;
  try {
    rules = parseHeaders(new TextDecoder().decode(headersFile));
  } catch (error) {
    if (error instanceof HeadersFileError) throw new SiteError(error.message);
    throw error;
  }

  // URL path -> entry (200), and URL path -> redirect target.
  const pages = new Map<string, Entry>();
  const redirects = new Map<string, string>();
  for (const [path, body] of files) {
    if (hidden(path)) continue;
    const entry: Entry = { body, type: contentType(path), etag: etagOf(body) };
    if (path.endsWith(".html")) {
      const clean = path === "/index.html" ? "/" : path.slice(0, -".html".length);
      pages.set(clean, entry);
      redirects.set(path, clean);
      if (path === "/index.html") redirects.set("/index", "/");
    } else {
      pages.set(path, entry);
    }
  }
  const notFound = pages.get("/404");

  const rulesFor = (path: string) => headersFor(rules, path);
  const withHeader = (list: [string, string][], name: string, value: string): [string, string][] => [
    ...list.filter(([n]) => n.toLowerCase() !== name.toLowerCase()),
    [name, value],
  ];
  const lacks = (list: [string, string][], name: string) => !list.some(([n]) => n.toLowerCase() === name.toLowerCase());

  function resolve(target: string, method: string, ifNoneMatch?: string): StaticResult {
    const decoded = decodeTarget(target);
    if (!decoded.ok) {
      return {
        status: 400,
        headers: [
          ["Content-Type", "text/plain; charset=utf-8"],
          ["Cache-Control", "no-store"],
        ],
        body: new TextEncoder().encode("Bad request\n"),
      };
    }
    const { path, query } = decoded;
    const headers = rulesFor(path);

    if (method !== "GET" && method !== "HEAD") {
      return { status: 405, headers: [...headers, ["Allow", "GET, HEAD"]], body: null };
    }

    const redirect = redirects.get(path);
    if (redirect !== undefined) return { status: 308, headers: [...headers, ["Location", redirect + query]], body: null };

    const entry = pages.get(path);
    if (entry !== undefined) {
      let out = headers;
      if (lacks(out, "Cache-Control")) out = [...out, ["Cache-Control", "public, max-age=0, must-revalidate"]];
      out = [...out, ["ETag", entry.etag]];
      if (ifNoneMatch !== undefined && matches(ifNoneMatch, entry.etag)) return { status: 304, headers: out, body: null };
      out = [...out, ["Content-Type", entry.type], ["Content-Length", String(entry.body.length)]];
      return { status: 200, headers: out, body: method === "HEAD" ? null : entry.body };
    }

    if (path.length > 1 && path.endsWith("/") && pages.has(path.slice(0, -1))) {
      // A trailing slash only gets the /* rules, like Pages.
      return { status: 308, headers: [...rulesFor("/*"), ["Location", path.slice(0, -1) + query]], body: null };
    }

    let out = withHeader(headers, "Cache-Control", "no-store");
    if (notFound === undefined) {
      out = [...out, ["Content-Type", "text/plain; charset=utf-8"]];
      return { status: 404, headers: out, body: method === "HEAD" ? null : new TextEncoder().encode("Not found\n") };
    }
    out = [...out, ["Content-Type", notFound.type], ["Content-Length", String(notFound.body.length)]];
    return { status: 404, headers: out, body: method === "HEAD" ? null : notFound.body };
  }

  return { resolve, origin, fileCount: pages.size };
}

/** If-None-Match: "*", or a comma list of entity tags compared weakly. */
function matches(header: string, etag: string): boolean {
  if (header.trim() === "*") return true;
  return header.split(",").some((part) => part.trim().replace(/^W\//, "") === etag);
}
