// Pure helpers for the two site profiles (no imports, no file access): HTML blocks, operator values,
// origin validation and the _headers / robots / sitemap rewrites for the self-host build.
// See docs/plans/self-host.md section 3.5.

export const OWNER_ORIGIN = "https://onetimepass.pages.dev";
export const GENERIC_OPERATOR_NAME = "the operator of this instance";
export const GENERIC_OPERATOR_CONTACT = "not published on this site";

const OWNER_OPEN = /^[ \t]*<!-- site:onetimepass -->[ \t]*\r?\n$/;
const OWNER_CLOSE = /^[ \t]*<!-- \/site:onetimepass -->[ \t]*\r?\n$/;
const SELF_OPEN = /^[ \t]*<!-- site:selfhost[ \t]*\r?\n$/;
const SELF_CLOSE = /^[ \t]*site:selfhost -->[ \t]*\r?\n$/;
const ANY_MARKER = /site:(?:onetimepass|selfhost)/;

const escapeHtml = (text) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * Keeps one profile's text of an HTML source. Marker lines are removed with their newline. Throws on nested,
 * unclosed or stray markers, on a marker that shares its line with other text, and on `<!--` or `-->` inside a
 * self-host block. `profile` is "onetimepass" or "selfhost".
 */
export function applyBlocks(html, profile) {
  if (profile !== "onetimepass" && profile !== "selfhost") throw new Error(`unknown profile ${profile}`);
  const lines = html.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const out = [];
  let state = null; // null | "owner" | "self"
  lines.forEach((line, i) => {
    const at = `line ${i + 1}`;
    const withNewline = line.endsWith("\n") ? line : `${line}\n`;
    if (OWNER_OPEN.test(withNewline)) {
      if (state !== null) throw new Error(`site marker nested or repeated at ${at}`);
      state = "owner";
    } else if (OWNER_CLOSE.test(withNewline)) {
      if (state !== "owner") throw new Error(`stray </site:onetimepass> marker at ${at}`);
      state = null;
    } else if (SELF_OPEN.test(withNewline)) {
      if (state !== null) throw new Error(`site marker nested or repeated at ${at}`);
      state = "self";
    } else if (SELF_CLOSE.test(withNewline)) {
      if (state !== "self") throw new Error(`stray site:selfhost --> marker at ${at}`);
      state = null;
    } else if (ANY_MARKER.test(line)) {
      throw new Error(`site marker must be alone on its line (${at})`);
    } else if (state === "self") {
      if (line.includes("<!--") || line.includes("-->")) throw new Error(`comment syntax inside a self-host block at ${at}`);
      if (profile === "selfhost") out.push(line);
    } else if (state === "owner") {
      if (profile === "onetimepass") out.push(line);
    } else {
      out.push(line);
    }
  });
  if (state !== null) throw new Error("unclosed site block");
  return out.join("");
}

/** HTML-escaped operator name, or the generic phrase. */
export function operatorNameHtml(raw) {
  if (raw === undefined || raw === "") return GENERIC_OPERATOR_NAME;
  if (raw.length > 200) throw new Error("ONETIME_OPERATOR_NAME is longer than 200 characters");
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new Error("ONETIME_OPERATOR_NAME must not contain control characters");
  if (raw.includes("{{") || raw.includes("}}")) throw new Error("ONETIME_OPERATOR_NAME must not contain {{ or }}");
  return escapeHtml(raw);
}

/** `<a>` for an email address or an https URL, or the unset phrase. Anything else throws. */
export function operatorContactHtml(raw) {
  if (raw === undefined || raw === "") return GENERIC_OPERATOR_CONTACT;
  if (raw.length > 200) throw new Error("ONETIME_OPERATOR_CONTACT is longer than 200 characters");
  if (/^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(raw)) {
    const text = escapeHtml(raw);
    return `<a href="mailto:${text}">${text}</a>`;
  }
  if (/^https:\/\/[^\s<>"'\\{}|^`]+$/.test(raw)) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      url = null;
    }
    if (url !== null && url.protocol === "https:" && url.username === "" && url.password === "" && url.hostname.includes(".")) {
      const text = escapeHtml(raw);
      return `<a href="${text}">${text}</a>`;
    }
  }
  throw new Error("ONETIME_OPERATOR_CONTACT must be an email address or an https URL");
}

/** Validates the public origin of a self-hosted instance and returns it normalised. */
export function parseOrigin(raw) {
  if (raw === undefined || raw === "") throw new Error("ONETIME_ORIGIN is required (for example https://onetime.example)");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`ONETIME_ORIGIN is not a URL: ${raw}`);
  }
  if (url.username !== "" || url.password !== "") throw new Error("ONETIME_ORIGIN must not contain credentials");
  if (raw !== url.origin) throw new Error(`ONETIME_ORIGIN must be an origin only (${url.origin}), without path, query or trailing slash`);
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && url.hostname === "localhost" && url.port !== "") return url.origin;
  throw new Error("ONETIME_ORIGIN must be https://<host> (http is allowed only for http://localhost:<port>)");
}

/** The whole HTML transform of one page. `opts`: { profile, origin, operatorName, operatorContact }. */
export function transformHtml(html, opts) {
  const kept = applyBlocks(html, opts.profile);
  if (opts.profile === "onetimepass") {
    if (/\{\{[A-Z_]*\}\}/.test(kept)) throw new Error("a {{PLACEHOLDER}} is left in the Pages profile (placeholders belong in self-host blocks)");
    return kept;
  }
  // Placeholders are filled in self-host blocks only, in one pass, so a value is never scanned again.
  const selfOnly = applyBlocks(html, "selfhost");
  const name = operatorNameHtml(opts.operatorName);
  const contact = operatorContactHtml(opts.operatorContact);
  // Outside self-host blocks no placeholder is allowed.
  const outsideSelf = applyBlocks(html, "onetimepass");
  if (/\{\{[A-Z_]*\}\}/.test(outsideSelf)) throw new Error("a {{PLACEHOLDER}} is outside a self-host block");
  const filled = selfOnly.replace(/\{\{([A-Z_]*)\}\}/g, (_m, key) => {
    if (key === "OPERATOR_NAME") return name;
    if (key === "OPERATOR_CONTACT") return contact;
    throw new Error(`unknown placeholder {{${key}}}`);
  });
  return filled.replaceAll(OWNER_ORIGIN, opts.origin);
}

const GOOGLE = /google|gtag/i;

/**
 * `_headers` for the self-host build: the info-path CSP overrides (detach and Google policy) are removed, so `/*` applies.
 * Not indexable (the default): `X-Robots-Tag: noindex` goes into the `/*` rule, so every response that carries rule
 * headers has it, and the separate rule on `/cli/*` is dropped (a header set twice would be joined as "noindex, noindex").
 */
export function headersForSelfhost(text, { indexable = false } = {}) {
  const lines = text.split("\n");
  const out = [];
  let inStar = false;
  for (const line of lines) {
    const isRule = line.trim() !== "" && !/^\s/.test(line) && !line.trim().startsWith("#");
    if (isRule) inStar = line.trim() === "/*";
    if (!inStar && /^\s+(?:! )?Content-Security-Policy\b/i.test(line)) continue;
    if (!indexable && /^\s+(?:! )?X-Robots-Tag\b/i.test(line)) continue;
    out.push(line);
    if (!indexable && isRule && inStar) out.push("  X-Robots-Tag: noindex");
  }
  // A rule left without any header (the /cli/* one) goes with the comment lines above it.
  const blocks = out.join("\n").split("\n\n");
  let result = blocks
    .filter((block) => {
      const rest = block.split("\n").filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
      return !(rest.length === 1 && !/^\s/.test(rest[0]) && !indexable && /^\/cli\/\*$/.test(rest[0].trim()));
    })
    .join("\n\n");
  if (text.endsWith("\n") && !result.endsWith("\n")) result += "\n";
  if (GOOGLE.test(result)) throw new Error("_headers still mentions Google after the self-host rewrite");
  return result;
}

/** robots.txt for the self-host build: closed by default, the original rules with the operator origin when indexable. */
export function robotsForSelfhost(text, { origin, indexable }) {
  if (!indexable) return "User-agent: *\nDisallow: /\n";
  return text.replaceAll(OWNER_ORIGIN, origin);
}

export function sitemapForSelfhost(text, origin) {
  return text.replaceAll(OWNER_ORIGIN, origin);
}

const OWNER_ADVISORY_URL = "https://github.com/devopsacid/onetime/security/advisories/new";
const OWNER_POLICY_URL = "https://github.com/devopsacid/onetime/blob/main/SECURITY.md";

/** RFC 9116 `Expires`: build time plus 11 months, so a file made by a build is never close to its end (RFC: under a year). */
export function securityTxtExpires(now) {
  const date = new Date(now.getTime());
  date.setUTCMonth(date.getUTCMonth() + 11);
  return `${date.toISOString().slice(0, 19)}Z`;
}

/** security.txt of the Pages profile. `privacyHtml` is the source of privacy.html: the published address is read from its mailto link. */
export function securityTxtForPages({ privacyHtml, now }) {
  const mail = /href="mailto:([^"\s]+)"/.exec(privacyHtml);
  if (mail === null) throw new Error("privacy.html has no mailto: link to use as the security contact");
  return [
    `Contact: ${OWNER_ADVISORY_URL}`,
    `Contact: mailto:${mail[1]}`,
    `Expires: ${securityTxtExpires(now)}`,
    `Canonical: ${OWNER_ORIGIN}/.well-known/security.txt`,
    `Policy: ${OWNER_POLICY_URL}`,
    "Preferred-Languages: en, sk",
    "",
  ].join("\n");
}

/** security.txt of a self-host build from the operator contact, or null when none is set (then no file is written). */
export function securityTxtForSelfhost({ origin, contact, now }) {
  if (contact === undefined || contact === "") return null;
  operatorContactHtml(contact); // validates: email address or https URL
  const value = contact.startsWith("https://") ? contact : `mailto:${contact}`;
  return [`Contact: ${value}`, `Expires: ${securityTxtExpires(now)}`, `Canonical: ${origin}/.well-known/security.txt`, ""].join("\n");
}
