#!/usr/bin/env node
// Smoke test of the built server against the self-host dist: start it on a free port with a temp database,
// check the main paths, /healthz and an API round trip, check that a second instance on the same database exits 3
// and that the Pages dist is refused, then stop it. Needs `pnpm build:selfhost` (and `pnpm build` for the refusal check).
// Usage: node tools/check-selfhost.mjs   (env ONETIME_TEST_TMP: where the temp database goes)

import { spawn, spawnSync } from "node:child_process";
import { connect } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Status code of `GET <target>` sent as-is over a plain socket. */
function rawStatus(port, target) {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
    let data = "";
    socket.on("data", (d) => (data += d));
    socket.on("close", () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0)));
    socket.on("error", () => resolve(0));
  });
}

const root = new URL("..", import.meta.url).pathname;
const server = join(root, "dist-server", "server.mjs");
const siteDir = join(root, "dist-selfhost");
const pagesDir = join(root, "dist");
const problems = [];
const expect = (ok, message) => {
  if (!ok) problems.push(message);
};

for (const path of [server, join(siteDir, "_selfhost.json")]) {
  if (!existsSync(path)) {
    console.error(`check-selfhost: ${path} is missing (run pnpm build:selfhost first)`);
    process.exit(1);
  }
}

const base = process.env.ONETIME_TEST_TMP ?? tmpdir();
mkdirSync(base, { recursive: true });
const tmp = mkdtempSync(join(base, "onetime-check-selfhost-"));
const dbPath = join(tmp, "data", "onetime.db");
const env = { ...process.env, HOST: "127.0.0.1", PORT: "0", ONETIME_DB: dbPath, ONETIME_DIST: siteDir };

let child;
try {
  child = spawn(process.execPath, ["--no-warnings", server], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start in 10 s\n${err}`)), 10_000);
    child.stdout.on("data", (d) => {
      out += d;
      const m = /listening on [^\s:]+:(\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (${code})\n${err}`));
    });
  });
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  const get = (path, init) => fetch(url(path), { redirect: "manual", ...init });

  const STRICT = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

  // Static table (docs/plans/self-host.md 3.4), main paths.
  for (const path of ["/", "/how-it-works", "/command-line", "/privacy", "/terms", "/404"]) {
    const r = await get(path);
    await r.arrayBuffer();
    expect(r.status === 200, `${path}: expected 200, got ${r.status}`);
    expect(r.headers.get("content-security-policy") === STRICT, `${path}: CSP is not the strict policy`);
    expect(r.headers.get("cache-control") === "no-store", `${path}: Cache-Control is not no-store`);
  }
  for (const [path, location] of [["/how-it-works.html", "/how-it-works"], ["/index.html", "/"], ["/how-it-works/", "/how-it-works"]]) {
    const r = await get(path);
    expect(r.status === 308 && r.headers.get("location") === location, `${path}: expected 308 to ${location}, got ${r.status} ${r.headers.get("location")}`);
  }
  for (const path of ["/nope", "/_headers", "/_selfhost.json", "/_routes.json", "/assets/nope.js"]) {
    const r = await get(path);
    await r.arrayBuffer();
    expect(r.status === 404, `${path}: expected 404, got ${r.status}`);
  }
  // fetch() would normalise dot segments, so send these request targets over a raw socket.
  for (const target of ["/../etc/passwd", "/%2e%2e/etc/passwd"]) {
    const status = await rawStatus(port, target);
    expect(status === 400, `${target}: expected 400, got ${status}`);
  }
  // X-Robots-Tag: a build that is not indexable (no sitemap) marks every response noindex; an indexable one only /cli/*.
  const indexable = existsSync(join(siteDir, "sitemap.xml"));
  for (const path of ["/", "/how-it-works", "/robots.txt", "/favicon.svg", "/cli/onetime.mjs", "/nope", "/how-it-works/"]) {
    const r = await get(path);
    await r.arrayBuffer();
    const tag = r.headers.get("x-robots-tag");
    const want = path.startsWith("/cli/") || !indexable ? "noindex" : null;
    expect(tag === want, `${path}: X-Robots-Tag is ${JSON.stringify(tag)}, expected ${JSON.stringify(want)} (${indexable ? "indexable" : "not indexable"} build)`);
  }
  const robots = await (await get("/robots.txt")).text();
  expect(/Disallow: \/\s*$/m.test(robots) || robots.includes("Sitemap:"), "robots.txt looks wrong");
  const post = await get("/", { method: "POST" });
  expect(post.status === 405, `POST /: expected 405, got ${post.status}`);

  const health = await get("/healthz");
  expect(health.status === 200 && (await health.text()).trim() === "ok", "/healthz is not 200 ok");

  // API round trip: create, status, GET reveal refused, POST reveal returns the bytes, second reveal gone.
  const blob = new Uint8Array(64).map((_, i) => (i * 7) % 256);
  const created = await get("/api/secrets?ttl=3600", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: blob });
  const { id } = created.status === 201 ? await created.json() : { id: "" };
  expect(created.status === 201 && typeof id === "string" && id.length > 0, `create: expected 201, got ${created.status}`);
  expect((await get(`/api/secrets/${id}`)).status === 200, "status: expected 200");
  expect((await get(`/api/secrets/${id}/reveal`)).status === 405, "GET reveal: expected 405");
  const revealed = await get(`/api/secrets/${id}/reveal`, { method: "POST" });
  const bytes = new Uint8Array(await revealed.arrayBuffer());
  expect(revealed.status === 200 && bytes.length === blob.length && bytes.every((b, i) => b === blob[i]), "POST reveal did not return the same bytes");
  expect((await get(`/api/secrets/${id}/reveal`, { method: "POST" })).status === 404, "second reveal: expected 404");
  expect(created.headers.get("content-security-policy") === "default-src 'none'; frame-ancestors 'none'", "API responses must carry the API's own CSP, not the site's");
  expect(created.headers.get("cross-origin-resource-policy") === "same-origin", "API responses must carry CORP same-origin");
  expect((created.headers.get("strict-transport-security") ?? "").startsWith("max-age="), "API responses must carry HSTS");

  // A second instance on the same database must refuse (exit 3).
  const second = spawnSync(process.execPath, ["--no-warnings", server], { env, encoding: "utf8", timeout: 10_000 });
  expect(second.status === 3, `second instance: expected exit 3, got ${second.status}`);

  // The Pages build must be refused (exit 2).
  if (existsSync(join(pagesDir, "index.html"))) {
    const refused = spawnSync(process.execPath, ["--no-warnings", server], { env: { ...env, ONETIME_DIST: pagesDir, ONETIME_DB: join(tmp, "other.db") }, encoding: "utf8", timeout: 10_000 });
    expect(refused.status === 2, `Pages dist: expected exit 2, got ${refused.status}`);
  }

  // Stop: SIGTERM exits 0.
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  child.kill("SIGTERM");
  const code = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve("timeout"), 10_000))]);
  expect(code === 0, `SIGTERM: expected exit 0, got ${code}`);
  child = undefined;
} catch (error) {
  problems.push(error instanceof Error ? error.message : String(error));
} finally {
  if (child) child.kill("SIGKILL");
  rmSync(tmp, { recursive: true, force: true });
}

if (problems.length > 0) {
  console.error(`check-selfhost: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log("check-selfhost: server started on the self-host dist, static paths, /healthz and the API round trip OK; second instance exits 3, Pages dist refused, SIGTERM exits 0");
