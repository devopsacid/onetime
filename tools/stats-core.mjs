// Pure parts of the usage-counter viewer (docs/plans/usage-counters.md, decision 8): argument checks, the fixed query,
// the reply parser, the table, and the one capped request. No dependencies. The token comes from the environment only
// and never appears in a message. The entry point is tools/stats.mjs.

export const DEFAULT_DAYS = 7;
export const MAX_DAYS = 92; // Analytics Engine keeps three months
export const MAX_REPLY_BYTES = 1024 * 1024;
const HOST = "https://api.cloudflare.com";
const KINDS = ["text", "text-pass", "file", "file-pass", "unknown"];
const EVENTS = ["created", "revealed", "gone"];
const EVENT_NAME = { create: "created", reveal: "revealed", gone: "gone" };

/** A refusal that is safe to print. `code` is the exit code. */
export class StatsError extends Error {
  constructor(message, code = 5) {
    super(message);
    this.name = "StatsError";
    this.code = code;
  }
}

const ENV_HINT = "pass the token in the environment (ONETIME_STATS_TOKEN and ONETIME_STATS_ACCOUNT_ID), never as an argument";

function checkDays(text) {
  if (!/^[1-9]\d{0,2}$/.test(text) || Number(text) > MAX_DAYS) throw new StatsError(`--days takes a whole number from 1 to ${MAX_DAYS}`, 2);
  return Number(text);
}

/** Allowed: --days N, --format table|tsv. Anything that looks like a token or an account is refused without being echoed. */
export function parseArgs(argv) {
  let days = DEFAULT_DAYS;
  let how = "table";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const name = arg.split("=")[0];
    if (name === "--token" || name === "--account" || arg.length >= 40) throw new StatsError(ENV_HINT, 2);
    if (name === "--days" || name === "--format") {
      const inline = arg.includes("=");
      const value = inline ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      if (value === undefined) throw new StatsError(`${name} needs a value`, 2);
      if (value.length >= 40) throw new StatsError(ENV_HINT, 2);
      if (name === "--days") days = checkDays(value);
      else if (value === "table" || value === "tsv") how = value;
      else throw new StatsError("--format is table or tsv", 2);
    } else {
      throw new StatsError("usage: node tools/stats.mjs [--days N] [--format table|tsv]", 2);
    }
  }
  return { days, format: how };
}

/** The one query: constants plus a validated integer. */
export function buildQuery(days) {
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw new StatsError(`days must be a whole number from 1 to ${MAX_DAYS}`, 2);
  return (
    "SELECT formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' DAY), '%Y-%m-%d') AS day,\n" +
    "       blob1 AS event, blob2 AS label, SUM(_sample_interval) AS n\n" +
    "FROM onetime_usage\n" +
    `WHERE timestamp > now() - INTERVAL '${days}' DAY\n` +
    "GROUP BY day, event, label\n" +
    "ORDER BY day\n" +
    "FORMAT JSON"
  );
}

/** The rows of a JSON reply that have a plausible day, a known event and a count; anything else is dropped. */
export function parseReply(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new StatsError("the answer was not JSON");
  }
  if (body === null || typeof body !== "object" || !Array.isArray(body.data)) throw new StatsError("the answer had no data list");
  const rows = [];
  for (const row of body.data) {
    if (row === null || typeof row !== "object") continue;
    const { day, event, label } = row;
    const n = typeof row.n === "string" && /^\d{1,15}$/.test(row.n) ? Number(row.n) : row.n;
    if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if (event !== "view" && !(event in EVENT_NAME)) continue;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) continue;
    rows.push({ day, event, label: typeof label === "string" ? label : "", n });
  }
  return rows;
}

const zeroKinds = () => Object.fromEntries(KINDS.map((k) => [k, 0]));

/** One row per UTC day from `days` days ago to today, zeros where nothing was counted, labels outside the closed set summed into unknown. */
export function tabulate(rows, days, now = new Date()) {
  const byDay = new Map();
  const dayOf = (date) => date.toISOString().slice(0, 10);
  for (let i = days; i >= 0; i--) byDay.set(dayOf(new Date(now.getTime() - i * 86_400_000)), null);
  for (const row of rows) if (!byDay.has(row.day)) byDay.set(row.day, null);
  const out = [...byDay.keys()].sort().map((day) => ({ day, views: 0, created: zeroKinds(), revealed: zeroKinds(), gone: zeroKinds() }));
  const index = new Map(out.map((r) => [r.day, r]));
  for (const row of rows) {
    const target = index.get(row.day);
    if (row.event === "view") {
      if (row.label === "app") target.views += row.n;
      continue;
    }
    target[EVENT_NAME[row.event]][KINDS.includes(row.label) ? row.label : "unknown"] += row.n;
  }
  return out;
}

const HEADER = ["day", "views", ...EVENTS.flatMap((e) => KINDS.map((k) => `${e}:${k}`))];
const cells = (r) => [r.day, r.views, ...EVENTS.flatMap((e) => KINDS.map((k) => r[e][k]))].map(String);

export function format(rows, how) {
  const lines = [HEADER, ...rows.map(cells)];
  if (how === "tsv") return lines.map((l) => l.join("\t")).join("\n");
  const widths = HEADER.map((_, i) => Math.max(...lines.map((l) => l[i].length)));
  return lines.map((l) => l.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ")).join("\n");
}

async function readCapped(response) {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_REPLY_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new StatsError("the answer is too large");
  }
  const chunks = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REPLY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new StatsError("the answer is too large");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Asks Analytics Engine for the last `days` days. Errors never contain the token, the header or the answer body. */
export async function fetchStats({ env, days, fetch: doFetch = fetch, now = new Date() }) {
  const account = env.ONETIME_STATS_ACCOUNT_ID;
  const token = env.ONETIME_STATS_TOKEN;
  if (typeof account !== "string" || !/^[0-9a-f]{32}$/i.test(account)) throw new StatsError("set ONETIME_STATS_ACCOUNT_ID to the 32-character account id", 2);
  if (typeof token !== "string" || !/^[\x21-\x7e]{8,200}$/.test(token)) throw new StatsError("set ONETIME_STATS_TOKEN to the read-only API token", 2);
  const query = buildQuery(days);
  let text;
  try {
    const response = await doFetch(`${HOST}/client/v4/accounts/${account}/analytics_engine/sql`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
      body: query,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new StatsError(`Cloudflare answered HTTP ${response.status}`);
    }
    text = await readCapped(response);
  } catch (error) {
    if (error instanceof StatsError) throw error;
    throw new StatsError("could not reach Cloudflare");
  }
  return tabulate(parseReply(text), days, now);
}
