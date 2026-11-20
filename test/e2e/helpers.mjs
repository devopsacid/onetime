// Shared helpers for the browser e2e specs: link fixtures made with the real codec, a recording browser session, the
// browser list. Nothing here touches app source; the codec is bundled from src/web with esbuild at start.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, firefox, webkit } from "playwright-core";

const root = fileURLToPath(new URL("../..", import.meta.url));

export const ORIGIN = process.env.E2E_ORIGIN;
if (!ORIGIN) throw new Error("E2E_ORIGIN is not set: run `pnpm e2e` (test/e2e/run.mjs starts the server)");

const bundled = await build({
  stdin: {
    contents: `export { createCodec } from "./src/web/crypto"; export { buildLink } from "./src/web/link";`,
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
  logLevel: "silent",
});
const { createCodec, buildLink } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`);

const v1 = createCodec({ writeFormat: 1 });
const v2 = createCodec({ writeFormat: 2, writeFiles: true });

async function post(blob, ttl = 3600) {
  const response = await fetch(`${ORIGIN}/api/secrets?ttl=${ttl}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: blob });
  assert.ok(response.ok, `create answered ${response.status}`);
  return /** @type {{ id: string }} */ (await response.json()).id;
}

/** Each fixture returns { link, id, key, passphrase? }. The link is the full URL with the fragment. */
export async function textLink({ text, passphrase, format = 2 }) {
  const codec = format === 1 ? v1 : v2;
  const made = await codec.encryptSecret(text, passphrase);
  const id = await post(made.blob);
  return { id, key: made.key, passphrase, link: buildLink(ORIGIN, { id, key: made.key, format: made.format, passphrase: made.passphrase, file: false }) };
}

export async function fileLink({ name, type = "", bytes, passphrase }) {
  const made = await v2.encryptFile({ name, type, bytes }, passphrase);
  const id = await post(made.blob);
  return { id, key: made.key, passphrase, link: buildLink(ORIGIN, { id, key: made.key, format: 2, passphrase: made.passphrase, file: true }) };
}

/** 200 while the row exists, 404 once it was revealed (GET never burns). */
export async function statusOf(id) {
  return (await fetch(`${ORIGIN}/api/secrets/${id}`)).status;
}

const ALL = { chromium, firefox, webkit };

/** Launches each requested browser once; one that is missing is reported and skipped. */
export async function launchBrowsers(options = {}) {
  const names = (process.env.E2E_BROWSERS ?? "chromium,firefox,webkit").split(",").map((s) => s.trim()).filter(Boolean);
  const found = [];
  for (const name of names) {
    try {
      const extra = name === "webkit" && process.env.E2E_WEBKIT_LD_PRELOAD ? { env: { ...process.env, LD_PRELOAD: process.env.E2E_WEBKIT_LD_PRELOAD } } : {};
      const browser = await ALL[name].launch({ ...(options[name] ?? {}), ...extra });
      found.push({ name, browser });
    } catch (error) {
      console.log(`# browser ${name} could not start, skipped: ${String(error.message).split("\n")[0]}`);
    }
  }
  assert.ok(found.length > 0, "no browser could start");
  return found;
}

/**
 * A browser context that records every request, console message, dialog and extra page. `verify()` fails the test when
 * a request left the origin, a URL carried a key, fragment or passphrase, a dialog or popup appeared, or the console
 * reported a CSP violation or any error.
 */
export async function session(browser, { secrets = [], viewport, origin = ORIGIN } = {}) {
  const engine = browser.browserType().name();
  const context = await browser.newContext({ baseURL: origin, acceptDownloads: true, ...(viewport ? { viewport } : {}) });
  const requests = [];
  const problems = [];
  const consoleLines = [];
  let pages = 0;
  context.on("request", (request) => requests.push({ url: request.url(), method: request.method(), referer: request.headers().referer ?? "", post: request.postData() ?? "" }));
  context.on("page", (page) => {
    pages += 1;
    page.on("dialog", (dialog) => {
      problems.push(`dialog fired: ${dialog.type()} ${dialog.message()}`);
      void dialog.dismiss().catch(() => {});
    });
    page.on("console", (message) => consoleLines.push(`${message.type()}: ${message.text()}`));
    page.on("pageerror", (error) => consoleLines.push(`pageerror: ${error.message}`));
  });
  return {
    context,
    requests,
    pageCount: () => pages,
    /** Secrets (keys, passphrases) that must never appear in a URL or referer. */
    watch: (...values) => secrets.push(...values.filter(Boolean)),
    async verify({ allowConsole = [] } = {}) {
      for (const r of requests) {
        if (r.url.startsWith("data:") || r.url.startsWith("blob:") || r.url === "about:blank") continue;
        if (new URL(r.url).origin !== origin) problems.push(`request to another origin: ${r.url}`);
        if (r.url.includes("#")) problems.push(`fragment in request URL: ${r.url}`);
        for (const s of secrets) {
          if (r.url.includes(s) || r.referer.includes(s) || r.post.includes(s)) problems.push(`secret value in request: ${r.method} ${r.url}`);
        }
      }
      for (const line of consoleLines) {
        if (allowConsole.some((re) => re.test(line))) continue;
        if (engine === "webkit" && WEBKIT_SELECT_STYLE.test(line)) continue; // see WEBKIT_SELECT_STYLE
        if (/^(error|warning)/.test(line) || /content security policy|refused to/i.test(line) || line.startsWith("pageerror")) problems.push(`console: ${line}`);
      }
      assert.deepEqual(problems, [], problems.join("\n"));
    },
    close: () => context.close(),
  };
}

/**
 * Playwright's WebKit (WPE, headless) logs "Refused to apply a stylesheet ..." once per <select> on the create page. The
 * securitypolicyviolation event says style-src-attr, blockedURI "inline", no source file, console location
 * web-inspector://bootstrap.js: the engine styles its own select, the built HTML has no style attribute. The spec "no CSP
 * violation events" still checks every other directive and every other kind of violation in all browsers.
 */
export const WEBKIT_SELECT_STYLE = /^error: Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive/;

export const GONE_TITLE = "This secret is no longer available";

/**
 * A tiny reverse proxy in front of the app server that removes every Cache-Control header, so the browser may put the
 * pages in the back/forward cache (the real server answers no-store, which keeps Chromium out of it). Test-only: it lets
 * bfcache.spec.mjs prove the app's own pagehide/pageshow code in a real restore. Returns { origin, link(url), close }.
 */
export async function startNoStoreProxy() {
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (!["host", "connection", "content-length"].includes(k)) headers[k] = String(v);
      const upstream = await fetch(ORIGIN + req.url, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined, redirect: "manual" });
      const out = {};
      upstream.headers.forEach((v, k) => {
        if (!["cache-control", "content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) out[k] = v;
      });
      res.writeHead(upstream.status, out);
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      res.writeHead(502).end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, link: (url) => url.replace(ORIGIN, origin), close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }) };
}
