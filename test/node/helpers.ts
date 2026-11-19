import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMigrations } from "../../server/migrate";

export const MIGRATIONS_DIR = join(import.meta.dirname, "..", "..", "migrations");
export const migrations = () => readMigrations(MIGRATIONS_DIR);

/** A fresh temp directory under ~/.tmp-like space; the caller removes it. */
export function tempDir(prefix = "onetime-test-"): { path: string; remove(): void } {
  const base = process.env.ONETIME_TEST_TMP ?? tmpdir();
  mkdirSync(base, { recursive: true });
  const path = mkdtempSync(join(base, prefix));
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}

import { copyFileSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";

export const ROOT = join(import.meta.dirname, "..", "..");
export const PUBLIC_HEADERS = join(ROOT, "public", "_headers");

const page = (title: string) => `<!doctype html><title>${title}</title><p>${title}</p>\n`;

/** A small stand-in for a self-host `dist/`: the real `public/_headers` and `_routes.json`, sample pages and assets. */
export function makeDist(root: string, extra: { selfhost?: boolean } = {}): string {
  const dist = join(root, "dist-selfhost");
  mkdirSync(join(dist, "assets"), { recursive: true });
  mkdirSync(join(dist, "cli"), { recursive: true });
  for (const name of ["index", "how-it-works", "command-line", "privacy", "404"]) writeFileSync(join(dist, `${name}.html`), page(name));
  writeFileSync(join(dist, "assets", "main-abc123.js"), "console.log(1)\n");
  writeFileSync(join(dist, "assets", "style-abc123.css"), "body{}\n");
  writeFileSync(join(dist, "robots.txt"), "User-agent: *\nDisallow: /\n");
  writeFileSync(join(dist, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  writeFileSync(join(dist, "manifest.webmanifest"), "{}");
  writeFileSync(join(dist, "sitemap.xml"), "<urlset/>");
  writeFileSync(join(dist, "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(dist, "cli", "onetime.mjs"), "// cli\n");
  writeFileSync(join(dist, "cli", "onetime.cmd"), "@node\r\n");
  writeFileSync(join(dist, "cli", "onetime.mjs.sha256"), "00  onetime.mjs\n");
  copyFileSync(PUBLIC_HEADERS, join(dist, "_headers"));
  copyFileSync(join(ROOT, "public", "_routes.json"), join(dist, "_routes.json"));
  if (extra.selfhost !== false) writeFileSync(join(dist, "_selfhost.json"), JSON.stringify({ origin: "https://onetime.example" }));
  return dist;
}

/** Bundles the real server with tools/build-server.mjs into `outfile`. */
export function buildServerBundle(outfile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, "tools", "build-server.mjs"), outfile], { cwd: ROOT });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`build-server failed: ${err}`))));
  });
}

export interface Child {
  process: ChildProcess;
  stdout(): string;
  stderr(): string;
  exited: Promise<number | null>;
}

export function runServer(bundle: string, env: Record<string, string>): Child {
  const child = spawn(process.execPath, ["--no-warnings", bundle], { env: { PATH: process.env.PATH ?? "", ...env } });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  return { process: child, stdout: () => out, stderr: () => err, exited };
}

export async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
