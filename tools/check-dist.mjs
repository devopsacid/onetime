#!/usr/bin/env node
// Guards the CSP-relevant structure of the built pages (no dependencies).
// Fails on: inline <script> content other than application/ld+json, invalid JSON-LD, style="" attributes,
// <style> elements, on*="" handler attributes, and resource URLs (src, non-<a> href, action, poster, srcset,
// formaction, data, xlink:href, url(...) in attribute values) pointing anywhere but this site.
// Profiles (docs/plans/info-origin-split.md): `dir/_selfhost.json` present = self-host; else `--profile info` = the info
// site (dist-info); else the app (dist).
//   app:      one strict CSP in /* and no Google string in any file; index, command-line, 404 and cli/ present, the info
//             pages absent; _redirects exact (never a rule for / or /index.html); no resource URL to the info origin.
//   info:     INFO_CSP in /*; 404 and every chunk it loads free of Google strings; how-it-works, privacy, terms, 404 present,
//             no index, command-line, cli/, _routes.json or manifest; _redirects exact; no resource URL to the app origin.
//   selfhost: strict CSP, no GA, owner data or onetimepass(-info) hosts (cli/ may name the project URL); all six pages.
// All: every root-relative <a href> points into the build; no `site:` markers or {{placeholders}} left.
// Usage: node tools/check-dist.mjs [dir] [--profile info]   (default dir: dist)

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { INFO_CSP, INFO_ORIGIN, OWNER_ORIGIN, redirectsForApp, redirectsForInfo } from "./site-profile-core.mjs";

const RESOURCE_ATTRS = new Set(["src", "href", "action", "poster", "srcset", "formaction", "data", "xlink:href"]);

const args = process.argv.slice(2);
const profileFlag = args.indexOf("--profile");
if (profileFlag !== -1 && args[profileFlag + 1] !== "info") {
  console.error('check-dist: --profile accepts only "info"');
  process.exit(2);
}
const wantInfo = profileFlag !== -1;
const positional = args.filter((a, i) => !a.startsWith("--") && (profileFlag === -1 || i !== profileFlag + 1));
const root = positional[0] ?? "dist";
const problems = [];

// Profile: _selfhost.json decides. A broken one is a problem, not a fallback to the Pages rules.
let selfhost = false;
let OWN_ORIGIN = wantInfo ? INFO_ORIGIN : OWNER_ORIGIN;
{
  let raw = null;
  try {
    raw = readFileSync(join(root, "_selfhost.json"), "utf8");
  } catch {
    // app or info profile.
  }
  if (raw !== null) {
    selfhost = true;
    OWN_ORIGIN = OWNER_ORIGIN;
    try {
      const origin = JSON.parse(raw).origin;
      if (typeof origin !== "string" || !/^https?:\/\/[^/\s]+$/.test(origin)) throw new Error("no valid origin");
      OWN_ORIGIN = origin;
    } catch (error) {
      problems.push(`_selfhost.json is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function textFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return textFiles(path);
    return /\.(html|m?js|css|json|txt|xml|svg|webmanifest|sha256|cmd)$|^_(?:headers|redirects)$/.test(name) ? [path] : [];
  });
}

const profile = selfhost ? "selfhost" : wantInfo ? "info" : "app";
const exists = (name) => existsSync(join(root, name));

function htmlFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return htmlFiles(path);
    return name.endsWith(".html") ? [path] : [];
  });
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Relative URLs, fragments and absolute URLs on our own origin are fine; everything else is external. */
function isOwn(url) {
  const value = url.trim();
  if (value === "" || value.startsWith("#")) return true;
  if (value.startsWith("//")) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return value === OWN_ORIGIN || value.startsWith(OWN_ORIGIN + "/");
  return true;
}

function decodeEntities(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const ATTR = /([^\s"'>\/=]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const TOKEN = /<!--[\s\S]*?-->|<!doctype[^>]*>|<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/gi;

function isFile(urlPath) {
  try {
    return statSync(join(root, urlPath)).isFile();
  } catch {
    return false;
  }
}

function checkFile(path) {
  const text = readFileSync(path, "utf8");
  const file = relative(process.cwd(), path);
  const report = (index, message) => problems.push(`${file}:${lineOf(text, index)}: ${message}`);
  const ldBlocks = [];

  TOKEN.lastIndex = 0;
  let match;
  while ((match = TOKEN.exec(text)) !== null) {
    const [, closing, rawName, rawAttrs = ""] = match;
    if (!rawName || closing) continue;
    const name = rawName.toLowerCase();
    const attrs = new Map();

    ATTR.lastIndex = 0;
    let a;
    while ((a = ATTR.exec(rawAttrs)) !== null) {
      const attr = a[1].toLowerCase();
      const value = decodeEntities(a[3] ?? a[4] ?? a[5] ?? "");
      attrs.set(attr, value);
      if (attr === "style") report(match.index, `style attribute on <${name}>`);
      if (/^on[a-z]+$/.test(attr)) report(match.index, `event handler attribute ${attr} on <${name}>`);
      if (RESOURCE_ATTRS.has(attr) && !(name === "a" && attr === "href")) {
        const urls = attr === "srcset" ? value.split(",").map((part) => part.trim().split(/\s+/)[0] ?? "") : [value];
        for (const url of urls) if (!isOwn(url)) report(match.index, `external URL in <${name} ${attr}>: ${url}`);
      }
      for (const css of value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
        if (!isOwn(css[2] ?? "")) report(match.index, `external url() in <${name} ${attr}>: ${css[2]}`);
      }
    }

    if (name === "a" && attrs.has("href")) {
      const href = attrs.get("href") ?? "";
      if (href.startsWith("/") && !href.startsWith("//")) {
        const path = href.split(/[?#]/)[0] ?? "";
        if (path !== "/" && !isFile(path) && !isFile(`${path}.html`)) report(match.index, `link to ${path}, which is not in this build`);
      }
    }

    if (name === "style") report(match.index, "<style> element");

    if (name === "script") {
      const end = text.toLowerCase().indexOf("</script", TOKEN.lastIndex);
      const contentEnd = end === -1 ? text.length : end;
      const content = text.slice(TOKEN.lastIndex, contentEnd);
      const type = (attrs.get("type") ?? "").trim().toLowerCase();
      if (type === "application/ld+json") {
        try {
          ldBlocks.push({ index: match.index, data: JSON.parse(content) });
        } catch (error) {
          report(match.index, `JSON-LD does not parse: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else if (content.trim() !== "") {
        report(match.index, `inline script content (type "${type || "classic"}")`);
      }
      TOKEN.lastIndex = contentEnd;
    }
  }
  checkFaq(text, ldBlocks, report);
}

const plainText = (html) => decodeEntities(html.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();

/** Every FAQPage object inside parsed JSON-LD, as [question, answer] lists. */
function faqPages(node, out = []) {
  if (Array.isArray(node)) for (const item of node) faqPages(item, out);
  else if (node !== null && typeof node === "object") {
    if (node["@type"] === "FAQPage") {
      const entities = Array.isArray(node.mainEntity) ? node.mainEntity : [node.mainEntity];
      out.push(entities.map((q) => [String(q?.name ?? ""), String(q?.acceptedAnswer?.text ?? "")]));
    }
    for (const value of Object.values(node)) if (typeof value === "object") faqPages(value, out);
  }
  return out;
}

/** The questions and answers shown in <section id="faq"> (<details><summary>question</summary><p>answer</p>). */
function visibleFaq(html) {
  const start = html.search(/<section\b[^>]*\bid\s*=\s*["']faq["']/i);
  if (start === -1) return null;
  const end = html.indexOf("</section", start);
  const section = html.slice(start, end === -1 ? html.length : end);
  return [...section.matchAll(/<summary\b[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi)].map((m) => [plainText(m[1]), plainText(m[2])]);
}

/** Each FAQPage JSON-LD block must equal the visible FAQ (questions and answers, whitespace normalised). */
function checkFaq(html, blocks, report) {
  for (const block of blocks) {
    for (const faq of faqPages(block.data)) {
      const visible = visibleFaq(html);
      if (visible === null) {
        report(block.index, "FAQPage JSON-LD but no visible <section id=\"faq\">");
        continue;
      }
      const ld = faq.map(([q, a]) => [plainText(q), plainText(a)]);
      if (ld.length !== visible.length) report(block.index, `FAQ JSON-LD has ${ld.length} questions, the page shows ${visible.length}`);
      for (let i = 0; i < Math.min(ld.length, visible.length); i++) {
        if (ld[i][0] !== visible[i][0]) report(block.index, `FAQ JSON-LD question ${i + 1} differs from the page: ${JSON.stringify(ld[i][0])}`);
        else if (ld[i][1] !== visible[i][1]) report(block.index, `FAQ JSON-LD answer ${i + 1} differs from the page: ${JSON.stringify(ld[i][0])}`);
      }
    }
  }
}

let files;
try {
  files = htmlFiles(root);
} catch {
  console.error(`check-dist: cannot read ${root}/ (run the build first)`);
  process.exit(1);
}
if (files.length === 0) {
  console.error(`check-dist: no .html files in ${root}/`);
  process.exit(1);
}
for (const file of files) checkFile(file);

const FORBIDDEN = /googletagmanager|google-analytics|analytics\.google|gtag|G-W3GR41J2NR/i;
const GOOGLE_URL = /(?:https?:)?\/\/[^\s"'<>]*(?:google|gstatic|doubleclick)[^\s"'<>]*/i;

function localRef(ref, from) {
  const value = ref.split(/[?#]/)[0];
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:|^\/\//.test(value) || value === "") return null;
  return value.startsWith("/") ? join(root, value) : resolve(dirname(from), value);
}

/** The HTML page plus every JS/CSS file it pulls in. */
function reachable(page) {
  const seen = new Set();
  const queue = [];
  const html = readFileSync(page, "utf8");
  for (const m of html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const path = localRef(m[1], page);
    if (path && /\.(m?js|css)$/.test(path)) queue.push(path);
  }
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      problems.push(`${relative(process.cwd(), page)}: referenced file is missing: ${relative(process.cwd(), file)}`);
      continue;
    }
    if (!file.endsWith(".js")) continue;
    for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)) {
      const path = localRef(m[1], file);
      if (path && /\.m?js$/.test(path)) queue.push(path);
    }
  }
  return [...seen];
}

for (const name of profile === "info" ? ["404.html"] : ["index.html", "404.html"]) {
  const page = join(root, name);
  if (!existsSync(page)) continue; // reported by the file rules below
  const targets = [page, ...reachable(page)];
  for (const file of targets) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const hit = FORBIDDEN.exec(text);
    if (hit) problems.push(`${relative(process.cwd(), file)}: analytics string "${hit[0]}" in ${name} or a file it loads`);
  }
}
// _headers guard: exactly one CSP line in /*: the strict policy (app, self-host) or INFO_CSP (info). Nothing detaches it.
{
  const STRICT = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  const expected = profile === "info" ? INFO_CSP : STRICT;
  let headersText = null;
  try {
    headersText = readFileSync(join(root, "_headers"), "utf8");
  } catch {
    problems.push(`${root}/_headers is missing`);
  }
  if (headersText !== null) {
    const rules = new Map();
    let current = null;
    for (const raw of headersText.split("\n")) {
      if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
      if (!/^\s/.test(raw)) {
        current = raw.trim();
        rules.set(current, rules.get(current) ?? []);
      } else if (current !== null) rules.get(current).push(raw.trim());
    }
    if (/unsafe-inline/i.test(headersText)) problems.push("_headers: 'unsafe-inline' appears");
    // Files are saved through <a download> on a blob: URL, which needs no CSP source: the policy must never name blob: or data:.
    for (const [path, lines] of rules) {
      for (const line of lines) {
        const scheme = /(?:^|[\s;])(blob|data):/i.exec(line);
        if (scheme && /content-security-policy/i.test(line)) problems.push(`_headers: the CSP for ${path} names ${scheme[1].toLowerCase()}: (files are saved with <a download>, which needs no CSP source)`);
        else if (scheme) problems.push(`_headers: ${scheme[1].toLowerCase()}: appears in a header of ${path}`);
      }
    }
    if (/^\s*!/m.test(headersText)) problems.push("_headers: a detach line (! Name) appears; one CSP applies to every path");
    const allCsp = [...rules].flatMap(([path, lines]) => lines.filter((l) => /content-security-policy/i.test(l)).map(() => path));
    if (allCsp.length !== 1 || allCsp[0] !== "/*") problems.push(`_headers: exactly one Content-Security-Policy line, in /*, is required (found ${allCsp.length}: ${allCsp.join(", ")})`);
    const csp = (rules.get("/*") ?? []).filter((l) => /^content-security-policy:/i.test(l));
    if (csp.length === 1 && csp[0].replace(/^[^:]+:\s*/, "") !== expected) problems.push(`_headers: the /* CSP is not the ${profile === "info" ? "info" : "strict"} policy`);
    if (profile !== "info" && /googletagmanager|google-analytics|analytics\.google/i.test(headersText)) problems.push("_headers: a Google host outside the info site");
    // The /* rule carries the feature lockdown and CORP in every profile; the copy button needs clipboard-write for itself.
    const header = (name) => (rules.get("/*") ?? []).filter((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`)).map((l) => l.replace(/^[^:]+:\s*/, ""));
    if (header("Cross-Origin-Resource-Policy").join() !== "same-origin") problems.push("_headers: /* must set Cross-Origin-Resource-Policy: same-origin");
    const permissions = header("Permissions-Policy");
    if (permissions.length !== 1) problems.push("_headers: /* must set exactly one Permissions-Policy");
    else {
      for (const feature of ["accelerometer", "browsing-topics", "camera", "geolocation", "gyroscope", "magnetometer", "microphone", "payment", "usb"]) {
        if (!permissions[0].split(",").some((p) => p.trim() === `${feature}=()`)) problems.push(`_headers: Permissions-Policy must turn off ${feature} with ${feature}=()`);
      }
      if (!permissions[0].split(",").some((p) => p.trim() === "clipboard-write=(self)")) problems.push("_headers: Permissions-Policy must keep clipboard-write=(self)");
    }
  }
}

// Which files exist (rule 3).
{
  const must = { app: ["index.html", "command-line.html", "404.html", "cli"], info: ["how-it-works.html", "privacy.html", "terms.html", "404.html"], selfhost: ["index.html", "how-it-works.html", "command-line.html", "privacy.html", "terms.html", "404.html"] }[profile];
  const mustNot = { app: ["how-it-works.html", "privacy.html", "terms.html"], info: ["index.html", "command-line.html", "cli", "_routes.json", "manifest.webmanifest", "_worker.js"], selfhost: ["_redirects"] }[profile];
  for (const name of must) if (!exists(name)) problems.push(`${profile} build: ${name} is missing`);
  for (const name of mustNot) if (exists(name)) problems.push(`${profile} build: ${name} must not be present`);
}

// _redirects (rule 5): the exact generated text; the app never redirects / or /index.html.
if (profile !== "selfhost") {
  let text = null;
  try {
    text = readFileSync(join(root, "_redirects"), "utf8");
  } catch {
    problems.push(`${root}/_redirects is missing`);
  }
  if (text !== null) {
    if (profile === "app") {
      for (const line of text.split("\n")) {
        const source = line.trim().split(/\s+/)[0];
        if (source === "/" || source === "/index.html") problems.push(`_redirects: a rule for ${source} (a secret link's fragment must never follow a redirect)`);
      }
    }
    if (text !== (profile === "app" ? redirectsForApp() : redirectsForInfo())) problems.push(`_redirects does not equal the generated ${profile} redirects`);
  }
}

// Usage counters (docs/plans/usage-counters.md): the page-load beacon `view=app` exists only in the app build, at most once,
// in the entry chunk of index.html; the Function serves /api/* and nothing else.
{
  const MIN_VIEW_BEACONS = 1;
  const beacon = /view=app/g;
  const hits = textFiles(root).flatMap((file) => {
    const n = (readFileSync(file, "utf8").match(beacon) ?? []).length;
    return n > 0 ? [[file, n]] : [];
  });
  if (profile !== "app") {
    for (const [file] of hits) problems.push(`${relative(process.cwd(), file)}: view=app (the usage beacon) in a ${profile} build`);
  } else {
    const total = hits.reduce((sum, [, n]) => sum + n, 0);
    const index = exists("index.html") ? readFileSync(join(root, "index.html"), "utf8") : "";
    const entry = /<script[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/.exec(index)?.[1];
    const entryPath = entry === undefined ? null : resolve(root, `.${entry.startsWith("/") ? "" : "/"}${entry}`);
    if (total > 1 || total < MIN_VIEW_BEACONS) problems.push(`app build: view=app must appear exactly once (found ${total})`);
    for (const [file] of hits) {
      if (entryPath === null || resolve(file) !== entryPath) problems.push(`${relative(process.cwd(), file)}: view=app outside the entry chunk of index.html`);
    }
    if (exists("_routes.json")) {
      let routes = null;
      try {
        routes = JSON.parse(readFileSync(join(root, "_routes.json"), "utf8"));
      } catch {
        // reported below
      }
      const include = routes?.include;
      if (!Array.isArray(include) || include.length !== 1 || include[0] !== "/api/*" || (routes.exclude ?? []).length !== 0) {
        problems.push('_routes.json: must include only "/api/*" (counters must never route pages through the Function)');
      }
    } else problems.push("app build: _routes.json is missing");
  }
}

// No Google string anywhere in the app (rule 2); the info site is checked through 404.html above.
if (profile === "app") {
  for (const file of textFiles(root)) {
    const text = readFileSync(file, "utf8");
    const hit = FORBIDDEN.exec(text);
    if (hit) problems.push(`${relative(process.cwd(), file)}:${lineOf(text, hit.index)}: analytics string "${hit[0]}" in the app build`);
  }
}
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const hit = GOOGLE_URL.exec(text);
  if (hit) problems.push(`${relative(process.cwd(), file)}: Google URL in HTML: ${hit[0]}`);
}

// Markers and placeholders must not survive the build, in either profile.
for (const file of textFiles(root)) {
  if (!/\.(html|txt|xml|json|svg|webmanifest)$/.test(file)) continue;
  const text = readFileSync(file, "utf8");
  const marker = /<!-- \/?site:(?:onetimepass|selfhost)|^\s*site:selfhost -->/m.exec(text);
  if (marker) problems.push(`${relative(process.cwd(), file)}:${lineOf(text, marker.index)}: site block marker left in the output`);
  const placeholder = /\{\{[A-Z_]+\}\}/.exec(text);
  if (placeholder) problems.push(`${relative(process.cwd(), file)}:${lineOf(text, placeholder.index)}: placeholder left in the output: ${placeholder[0]}`);
}

// security.txt (RFC 9116): required in the Pages build, optional in self-host (only with an operator contact).
// Expires must parse, be at least 30 days ahead and under a year; Contact and a Canonical for this origin are required.
{
  let txt = null;
  try {
    txt = readFileSync(join(root, ".well-known", "security.txt"), "utf8");
  } catch {
    if (!selfhost) problems.push(".well-known/security.txt is missing from the app or info build");
  }
  if (txt !== null) {
    const field = (name) => [...txt.matchAll(new RegExp(`^${name}:[ \\t]*(.+?)[ \\t]*$`, "gim"))].map((m) => m[1]);
    if (field("Contact").length === 0) problems.push("security.txt: no Contact field");
    const canonical = field("Canonical");
    if (canonical.length !== 1 || canonical[0] !== `${OWN_ORIGIN}/.well-known/security.txt`) problems.push(`security.txt: Canonical must be ${OWN_ORIGIN}/.well-known/security.txt`);
    const expires = field("Expires");
    const at = expires.length === 1 && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(expires[0]) ? Date.parse(expires[0]) : NaN;
    const days = (at - Date.now()) / 864e5;
    if (Number.isNaN(days)) problems.push("security.txt: Expires is missing, repeated or not an ISO 8601 date-time");
    else if (days < 30) problems.push(`security.txt: Expires is ${days < 0 ? "in the past" : "less than 30 days away"} (rebuild; the build sets it 11 months ahead)`);
    else if (days > 366) problems.push("security.txt: Expires is more than a year ahead (RFC 9116 says less than a year)");
    if (selfhost && /devopsacid|onetimepass|github\.com\/[^\s]*\/security\/advisories/i.test(txt)) problems.push("security.txt: the original site's contact or repository in a self-host build");
  }
}

if (selfhost) {
  // Nothing of the owner's analytics or identity may ship in a self-host build.
  const GA = /googletagmanager|google-analytics|analytics\.google|gtag|G-W3GR41J2NR/i;
  const OWNER_MAIL = new RegExp(["michal", "maxian\\.sk"].join("@"), "i");
  for (const file of textFiles(root)) {
    const text = readFileSync(file, "utf8");
    const rel = relative(process.cwd(), file);
    const inCli = relative(root, file).startsWith(`cli${"/"}`);
    const ga = GA.exec(text);
    if (ga) problems.push(`${rel}:${lineOf(text, ga.index)}: analytics string "${ga[0]}" in a self-host build`);
    const mail = OWNER_MAIL.exec(text);
    if (mail) problems.push(`${rel}:${lineOf(text, mail.index)}: the owner's address in a self-host build`);
    if (text.includes("onetimepass-info")) problems.push(`${rel}: onetimepass-info in a self-host build`);
    if (!inCli && text.includes("onetimepass.pages.dev")) problems.push(`${rel}: onetimepass.pages.dev outside cli/ in a self-host build`);
  }
}

if (problems.length > 0) {
  console.error(`check-dist: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`check-dist: ${profile} profile, ${files.length} HTML files OK (no inline script or style, no handlers, no external resources, JSON-LD valid, links resolve, ${profile === "info" ? "no analytics code reachable from 404.html" : "no analytics code"})`);
