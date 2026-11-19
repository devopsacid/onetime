import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { afterAll, afterEach, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMigrations } from "../../server/migrate";

export const MIGRATIONS_DIR = join(import.meta.dirname, "..", "..", "migrations");
export const migrations = () => readMigrations(MIGRATIONS_DIR);

// Everything a test file creates is tracked here and cleaned up by hooks registered when a test file imports this module.
// - Child processes are killed after every test, so a failed or timed-out test cannot leave a server running.
// - Directories created while a test runs (including in beforeEach) are removed after that test.
// - Directories created earlier (at collection time or in beforeAll) are removed after the last test of the file,
//   in case the file's own afterAll did not run.
const children = new Set<ChildProcess>();
const testDirs = new Set<string>();
const fileDirs = new Set<string>();
let inTest = false;

beforeEach(() => {
  inTest = true;
});
afterEach(async () => {
  inTest = false;
  await killChildren();
  for (const path of testDirs) rmSync(path, { recursive: true, force: true });
  testDirs.clear();
});
afterAll(async () => {
  await killChildren();
  for (const path of [...fileDirs, ...testDirs]) rmSync(path, { recursive: true, force: true });
  fileDirs.clear();
});

async function killChildren(): Promise<void> {
  const running = [...children].filter((c) => c.exitCode === null && c.signalCode === null);
  children.clear();
  await Promise.all(
    running.map(
      (c) =>
        new Promise<void>((resolve) => {
          c.once("close", () => resolve());
          c.kill("SIGKILL");
        }),
    ),
  );
}

/** Registers a child process to be killed after the current test. Returns it. */
export function trackChild<T extends ChildProcess>(child: T): T {
  children.add(child);
  return child;
}

/** A fresh temp directory. `remove()` deletes it at once; otherwise the hooks above do. */
export function tempDir(prefix = "onetime-test-"): { path: string; remove(): void } {
  const base = process.env.ONETIME_TEST_TMP ?? tmpdir();
  mkdirSync(base, { recursive: true });
  const path = mkdtempSync(join(base, prefix));
  (inTest ? testDirs : fileDirs).add(path);
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
    const child = trackChild(spawn(process.execPath, [join(ROOT, "tools", "build-server.mjs"), outfile], { cwd: ROOT }));
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
  const child = trackChild(spawn(process.execPath, ["--no-warnings", bundle], { env: { PATH: process.env.PATH ?? "", ...env } }));
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
