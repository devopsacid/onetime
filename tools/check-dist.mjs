#!/usr/bin/env node
// Guards the CSP-relevant structure of the built pages (no dependencies).
// Fails on: inline <script> content other than application/ld+json, invalid JSON-LD, style="" attributes,
// <style> elements, on*="" handler attributes, and resource URLs (src, non-<a> href, action, poster, srcset,
// formaction, data, xlink:href, url(...) in attribute values) pointing anywhere but this site.
// Analytics guard: the app page (index.html) and 404.html, with every JS/CSS file they load (directly, via
// modulepreload or via imports), must not contain googletagmanager, google-analytics or gtag; no HTML file may
// contain a Google URL.
// Usage: node tools/check-dist.mjs [dir]   (default: dist)

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const OWN_ORIGIN = "https://onetimepass.pages.dev";
const RESOURCE_ATTRS = new Set(["src", "href", "action", "poster", "srcset", "formaction", "data", "xlink:href"]);

const root = process.argv[2] ?? "dist";
const problems = [];

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

function checkFile(path) {
  const text = readFileSync(path, "utf8");
  const file = relative(process.cwd(), path);
  const report = (index, message) => problems.push(`${file}:${lineOf(text, index)}: ${message}`);

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

    if (name === "style") report(match.index, "<style> element");

    if (name === "script") {
      const end = text.toLowerCase().indexOf("</script", TOKEN.lastIndex);
      const contentEnd = end === -1 ? text.length : end;
      const content = text.slice(TOKEN.lastIndex, contentEnd);
      const type = (attrs.get("type") ?? "").trim().toLowerCase();
      if (type === "application/ld+json") {
        try {
          JSON.parse(content);
        } catch (error) {
          report(match.index, `JSON-LD does not parse: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else if (content.trim() !== "") {
        report(match.index, `inline script content (type "${type || "classic"}")`);
      }
      TOKEN.lastIndex = contentEnd;
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

const FORBIDDEN = /googletagmanager|google-analytics|gtag/i;
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

for (const name of ["index.html", "404.html"]) {
  const page = join(root, name);
  const targets = [page, ...(() => { try { return reachable(page); } catch { return []; } })()];
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
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const hit = GOOGLE_URL.exec(text);
  if (hit) problems.push(`${relative(process.cwd(), file)}: Google URL in HTML: ${hit[0]}`);
}

if (problems.length > 0) {
  console.error(`check-dist: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`check-dist: ${files.length} HTML files OK (no inline script or style, no handlers, no external resources, JSON-LD valid, no analytics code reachable from index.html or 404.html)`);
