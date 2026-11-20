#!/usr/bin/env node
// Browser e2e runner (`pnpm e2e`): builds the self-host profile, starts dist-server/server.mjs on a free port with a temporary
// database, runs test/e2e/*.spec.mjs with node:test against it, then stops the server and deletes the temp directory.
// Env: E2E_BROWSERS=chromium,firefox,webkit (default all three; a browser that is not installed is skipped and reported),
//      E2E_SPEC=part-of-file-name (run only matching specs),
//      E2E_NO_BUILD=1 (reuse dist-selfhost and dist-server), E2E_TMP (parent of the temp directory; default the OS temp dir).
//      E2E_WEBKIT_LD_PRELOAD=lib1:lib2 (only for hosts missing WebKit's system libraries and no root: LD_PRELOAD for WebKit only).
// Needs Playwright browsers: `pnpm exec playwright-core install chromium firefox webkit`.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const here = fileURLToPath(new URL(".", import.meta.url));

if (process.env.E2E_NO_BUILD !== "1") {
  // The origin only lands in canonical links and the CLI; the app itself never reads it.
  const build = spawnSync("pnpm", ["build:selfhost"], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, ONETIME_ORIGIN: "http://localhost:8080" },
  });
  if (build.status !== 0) {
    console.error("e2e: pnpm build:selfhost failed");
    process.exit(1);
  }
}

const parent = process.env.E2E_TMP ?? tmpdir();
mkdirSync(parent, { recursive: true });
const tmp = mkdtempSync(join(parent, "onetime-e2e-"));
let server;
let code = 1;
const stop = () => {
  server?.kill("SIGKILL");
  rmSync(tmp, { recursive: true, force: true });
};
process.on("SIGINT", () => {
  stop();
  process.exit(130);
});
process.on("SIGTERM", () => {
  stop();
  process.exit(143);
});

try {
  server = spawn(process.execPath, ["--no-warnings", join(root, "dist-server", "server.mjs")], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: "0", ONETIME_DB: join(tmp, "data", "onetime.db"), ONETIME_DIST: join(root, "dist-selfhost") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  server.stderr.on("data", (d) => (err += d));
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start in 15 s\n${err}`)), 15_000);
    server.stdout.on("data", (d) => {
      out += d;
      const m = /listening on [^\s:]+:(\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    server.once("exit", (c) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (${c})\n${err}`));
    });
  });
  const specs = readdirSync(here).filter((f) => f.endsWith(".spec.mjs") && f.includes(process.env.E2E_SPEC ?? "")).map((f) => join(here, f));
  const test = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=spec", "--test-timeout=300000", ...specs], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, E2E_ORIGIN: `http://127.0.0.1:${port}` },
  });
  code = await new Promise((resolve) => test.once("exit", (c) => resolve(c ?? 1)));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
} finally {
  stop();
}
process.exit(code);
