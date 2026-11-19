/**
 * Parser for the subset of the Cloudflare Pages `_headers` format this project uses.
 * Anything outside the subset refuses to load: silently mis-matching a rule could weaken the CSP.
 * https://developers.cloudflare.com/pages/configuration/headers/
 */

export class HeadersFileError extends Error {
  constructor(message: string) {
    super(`_headers: ${message}`);
    this.name = "HeadersFileError";
  }
}

type Action = { kind: "set"; name: string; value: string } | { kind: "detach"; name: string };

interface Rule {
  pattern: string;
  matcher: RegExp;
  actions: Action[];
}

export type HeaderRules = Rule[];

const MAX_RULES = 100;
const MAX_LINE = 2000;

function compile(pattern: string, line: number): RegExp {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(pattern)) throw new HeadersFileError(`line ${line}: absolute URL patterns are not supported`);
  if (!pattern.startsWith("/")) throw new HeadersFileError(`line ${line}: a pattern must start with /`);
  if (/:[A-Za-z_]/.test(pattern)) throw new HeadersFileError(`line ${line}: placeholders (:name) are not supported`);
  const parts = pattern.split("*");
  if (parts.length > 2) throw new HeadersFileError(`line ${line}: only one * per pattern is supported`);
  const escape = (text: string) => text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  return new RegExp(`^${parts.map(escape).join(".*")}$`, "s");
}

export function parseHeaders(text: string): HeaderRules {
  const rules: Rule[] = [];
  let current: Rule | undefined;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const n = i + 1;
    if (raw.length > MAX_LINE) throw new HeadersFileError(`line ${n}: longer than ${MAX_LINE} characters`);
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    if (!/^\s/.test(raw)) {
      if (rules.length >= MAX_RULES) throw new HeadersFileError(`more than ${MAX_RULES} rules`);
      current = { pattern: trimmed, matcher: compile(trimmed, n), actions: [] };
      rules.push(current);
      continue;
    }

    if (current === undefined) throw new HeadersFileError(`line ${n}: a header before any path pattern`);
    if (trimmed.startsWith("!")) {
      const name = trimmed.slice(1).trim();
      if (!/^[A-Za-z0-9-]+$/.test(name)) throw new HeadersFileError(`line ${n}: invalid header name to detach`);
      current.actions.push({ kind: "detach", name });
      continue;
    }
    const colon = trimmed.indexOf(":");
    const name = colon > 0 ? trimmed.slice(0, colon).trim() : "";
    const value = colon > 0 ? trimmed.slice(colon + 1).trim() : "";
    if (!/^[A-Za-z0-9-]+$/.test(name)) throw new HeadersFileError(`line ${n}: expected "Name: value"`);
    if (value.includes(":splat")) throw new HeadersFileError(`line ${n}: :splat in values is not supported`);
    current.actions.push({ kind: "set", name, value });
  }
  return rules;
}

/** The headers for a request path: every matching rule in file order, repeated names joined with ", ", `! Name` removes. */
export function headersFor(rules: HeaderRules, path: string): [string, string][] {
  const out = new Map<string, [string, string]>();
  for (const rule of rules) {
    if (!rule.matcher.test(path)) continue;
    for (const action of rule.actions) {
      const key = action.name.toLowerCase();
      if (action.kind === "detach") {
        out.delete(key);
        continue;
      }
      const existing = out.get(key);
      out.set(key, existing ? [existing[0], `${existing[1]}, ${action.value}`] : [action.name, action.value]);
    }
  }
  return [...out.values()];
}
