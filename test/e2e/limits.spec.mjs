// Browser e2e: the create page follows GET /api/limits of the server it came from. Two extra self-host servers are started
// here (files off; 1 MiB files that last a day); the default server of run.mjs covers the hosted-like defaults.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { launchBrowsers, session } from "./helpers.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const bytesOf = (n) => Uint8Array.from({ length: n }, (_, i) => (i * 31) & 255);
const started = [];

async function startServer(env) {
  const dir = mkdtempSync(join(tmpdir(), "onetime-e2e-limits-"));
  const child = spawn(process.execPath, ["--no-warnings", join(root, "dist-server", "server.mjs")], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: "0", ONETIME_DB: join(dir, "data", "onetime.db"), ONETIME_DIST: join(root, "dist-selfhost"), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  started.push({ child, dir });
  let out = "";
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start\n${err}`)), 15_000);
    child.stdout.on("data", (d) => {
      out += d;
      const m = /listening on [^\s:]+:(\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.once("exit", (c) => reject(new Error(`server exited (${c})\n${err}`)));
  });
  return `http://127.0.0.1:${port}`;
}

const browsers = await launchBrowsers({ chromium: {}, firefox: {}, webkit: {} });
const filesOff = await startServer({ ONETIME_MAX_FILE_BYTES: "0" });
const bigFiles = await startServer({ ONETIME_MAX_FILE_BYTES: String(1024 * 1024), ONETIME_MAX_FILE_TTL: "86400" });
after(async () => {
  for (const { browser } of browsers) await browser.close();
  for (const { child, dir } of started) {
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

const offered = (page) => page.locator("#ttl option").evaluateAll((os) => os.filter((o) => !o.hidden && !o.disabled).map((o) => o.value));

for (const { name, browser } of browsers) {
  describe(`${name}: limits`, () => {
    it("files off (ONETIME_MAX_FILE_BYTES=0): file mode disabled with a note, text still works", async () => {
      const a = await session(browser, { origin: filesOff });
      try {
        const page = await a.context.newPage();
        await page.goto("/");
        await page.locator("#files-off").waitFor({ state: "visible" });
        assert.equal(await page.locator('input[name="mode"][value="file"]').isDisabled(), true);
        assert.match((await page.locator("#files-off").textContent()) ?? "", /does not accept files/);
        await page.locator("#secret").fill("still works");
        await page.locator("#create-submit").click();
        await page.locator("#view-created").waitFor({ state: "visible" });
        assert.match(await page.locator("#link").inputValue(), /#2\./);
        await a.verify();
      } finally {
        await a.close();
      }
    });

    it("larger limit: 1 MiB accepted, text shows 1.0 MB, expiry offers 1 hour and 1 day with 1 day selected", async () => {
      const a = await session(browser, { origin: bigFiles });
      try {
        const page = await a.context.newPage();
        await page.goto("/");
        await page.locator("#view-create").waitFor({ state: "visible" });
        await page.locator("#file-note [data-file-max]").waitFor({ state: "attached" });
        await page.waitForFunction(() => document.querySelector("#file-note [data-file-max]")?.textContent === "1.0 MB");
        assert.equal(await page.locator("#files-off").isHidden(), true);
        await page.locator('input[name="mode"][value="file"]').check();
        assert.deepEqual(await offered(page), ["3600", "86400"]);
        assert.equal(await page.locator("#ttl").inputValue(), "86400");
        assert.equal(await page.locator("#file-note [data-file-life]").textContent(), "1 day");
        await page.locator("#file-input").setInputFiles({ name: "big.bin", mimeType: "application/octet-stream", buffer: Buffer.from(bytesOf(1024 * 1024 + 1)) });
        await page.locator("#create-error").filter({ hasText: "Files can be at most 1.0 MB." }).waitFor();
        await page.locator("#file-input").setInputFiles({ name: "big.bin", mimeType: "application/octet-stream", buffer: Buffer.from(bytesOf(1024 * 1024)) });
        assert.equal(await page.locator("#create-error").isHidden(), true);
        await page.locator("#create-submit").click();
        await page.locator("#view-created").waitFor({ state: "visible" });
        assert.match(await page.locator("#link").inputValue(), /#2f\./);
        await a.verify();
      } finally {
        await a.close();
      }
    });

    it("a failed /api/limits keeps the hosted limits", async () => {
      const a = await session(browser, { origin: bigFiles });
      try {
        const page = await a.context.newPage();
        await page.route("**/api/limits", (route) => route.fulfill({ status: 500, body: "x" }));
        await page.goto("/");
        await page.locator("#view-create").waitFor({ state: "visible" });
        await page.locator('input[name="mode"][value="file"]').check();
        assert.deepEqual(await offered(page), ["3600"]);
        await page.locator("#file-input").setInputFiles({ name: "big.bin", mimeType: "application/octet-stream", buffer: Buffer.from(bytesOf(256 * 1024 + 1)) });
        await page.locator("#create-error").filter({ hasText: "Files can be at most 256.0 KB." }).waitFor();
      } finally {
        await a.close();
      }
    });
  });
}
