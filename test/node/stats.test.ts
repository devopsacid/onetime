import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildQuery, fetchStats, format, MAX_REPLY_BYTES, parseArgs, parseReply, StatsError, tabulate } from "../../tools/stats-core.mjs";
import { ROOT } from "./helpers";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "tok_" + "Z".repeat(36);
const NOW = new Date("2026-12-10T12:00:00Z");
const env = { ONETIME_STATS_ACCOUNT_ID: ACCOUNT, ONETIME_STATS_TOKEN: TOKEN };

const reply = (data: unknown[]) => JSON.stringify({ meta: [], data, rows: data.length });
const jsonResponse = (text: string, init: ResponseInit = {}) => new Response(text, { status: 200, ...init });

describe("parseArgs", () => {
  it("defaults to 7 days and a table, and takes --days and --format", () => {
    expect(parseArgs([])).toEqual({ days: 7, format: "table" });
    expect(parseArgs(["--days", "30", "--format", "tsv"])).toEqual({ days: 30, format: "tsv" });
    expect(parseArgs(["--days=1"])).toEqual({ days: 1, format: "table" });
    expect(parseArgs(["--days", "92"]).days).toBe(92);
  });
  it.each([["0"], ["93"], ["-1"], ["1.5"], ["x"], [""], ["1e1"]])("refuses --days %s", (n) => {
    expect(() => parseArgs(["--days", n])).toThrow(StatsError);
  });
  it("refuses a token or account in argv without echoing it", () => {
    for (const argv of [["--token", "x"], ["--token=abc"], ["--account", "abc"], ["--account=x"], ["a".repeat(40)], ["--days", "1", "b".repeat(64)]]) {
      let message = "";
      try {
        parseArgs(argv);
      } catch (error) {
        expect(error).toBeInstanceOf(StatsError);
        expect((error as StatsError).code).toBe(2);
        message = (error as Error).message;
      }
      expect(message).toMatch(/in the environment/);
      for (const part of argv) if (part.length > 3 && !part.startsWith("--")) expect(message).not.toContain(part);
    }
  });
  it("refuses anything else", () => {
    expect(() => parseArgs(["--format", "xml"])).toThrow(StatsError);
    expect(() => parseArgs(["--nope"])).toThrow(StatsError);
    expect(() => parseArgs(["extra"])).toThrow(StatsError);
  });
});

describe("buildQuery", () => {
  it("is the fixed query with only the validated integer in it", () => {
    expect(buildQuery(30)).toBe(
      "SELECT formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' DAY), '%Y-%m-%d') AS day,\n" +
        "       blob1 AS event, blob2 AS label, SUM(_sample_interval) AS n\n" +
        "FROM onetime_usage\n" +
        "WHERE timestamp > now() - INTERVAL '30' DAY\n" +
        "GROUP BY day, event, label\n" +
        "ORDER BY day\n" +
        "FORMAT JSON",
    );
  });
  it("refuses a non-integer or out-of-range count", () => {
    for (const bad of [0, 93, 1.5, Number.NaN, "7" as unknown as number, 1e21]) expect(() => buildQuery(bad)).toThrow(StatsError);
  });
});

describe("parseReply and tabulate", () => {
  const data = [
    { day: "2026-12-08", event: "view", label: "app", n: "5" },
    { day: "2026-12-08", event: "create", label: "text", n: 2 },
    { day: "2026-12-08", event: "create", label: "weird <b>label</b>", n: 3 },
    { day: "2026-12-10", event: "reveal", label: "file-pass", n: 1 },
    { day: "2026-12-10", event: "gone", label: "unknown", n: 4 },
    { day: "2026-12-10", event: "evil", label: "text", n: 9 },
    { day: "not a day\n", event: "view", label: "app", n: 9 },
    { day: "2026-12-10", event: "view", label: "app", n: -1 },
  ];
  it("keeps only well-formed rows, then sums per day, fills missing days with 0 and folds unknown labels", () => {
    const rows = tabulate(parseReply(reply(data)), 3, NOW);
    expect(rows.map((r) => r.day)).toEqual(["2026-12-07", "2026-12-08", "2026-12-09", "2026-12-10"]);
    expect(rows[0]).toMatchObject({ views: 0, created: { text: 0, unknown: 0 } });
    expect(rows[1]).toMatchObject({ views: 5, created: { text: 2, unknown: 3 } });
    expect(rows[2]!.views).toBe(0);
    expect(rows[3]).toMatchObject({ views: 0, revealed: { "file-pass": 1 }, gone: { unknown: 4 } });
  });
  it("renders a table and TSV with one line per day and no injected text", () => {
    const rows = tabulate(parseReply(reply(data)), 3, NOW);
    const tsv = format(rows, "tsv").split("\n");
    expect(tsv).toHaveLength(5);
    expect(tsv[0]!.split("\t")[0]).toBe("day");
    expect(tsv[2]!.split("\t")).toHaveLength(tsv[0]!.split("\t").length);
    expect(format(rows, "table")).not.toMatch(/weird|evil|not a day/);
    expect(format(rows, "table").split("\n")).toHaveLength(5);
  });
  it("refuses a reply that is not the expected JSON", () => {
    for (const bad of ["", "not json", "[]", "{}", '{"data":5}']) expect(() => parseReply(bad)).toThrow(StatsError);
  });
});

describe("fetchStats", () => {
  const ok = (text: string) => async () => jsonResponse(text);
  it("posts the query to the fixed host with the bearer token, and follows no redirect", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const rows = await fetchStats({
      env,
      days: 2,
      now: NOW,
      fetch: (async (url: string, init: RequestInit) => {
        seen = { url, init };
        return jsonResponse(reply([{ day: "2026-12-10", event: "view", label: "app", n: "3" }]));
      }) as unknown as typeof fetch,
    });
    expect(seen!.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/analytics_engine/sql`);
    expect(seen!.init.method).toBe("POST");
    expect(seen!.init.body).toBe(buildQuery(2));
    expect(seen!.init.redirect).toBe("error");
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(rows.at(-1)!.views).toBe(3);
  });
  it("needs both variables, shaped sanely", async () => {
    for (const bad of [{}, { ONETIME_STATS_ACCOUNT_ID: ACCOUNT }, { ...env, ONETIME_STATS_ACCOUNT_ID: "../x" }, { ...env, ONETIME_STATS_TOKEN: "a b\nc" }]) {
      await expect(fetchStats({ env: bad, days: 1, fetch: ok("{}") as unknown as typeof fetch })).rejects.toThrow(StatsError);
    }
  });
  it("refuses a reply over 1 MiB, by header and by stream", async () => {
    const big = "x".repeat(MAX_REPLY_BYTES + 1);
    await expect(fetchStats({ env, days: 1, fetch: ok(big) as unknown as typeof fetch })).rejects.toThrow(/too large/);
    const declared = async () => jsonResponse("{}", { headers: { "Content-Length": String(MAX_REPLY_BYTES + 1) } });
    await expect(fetchStats({ env, days: 1, fetch: declared as unknown as typeof fetch })).rejects.toThrow(/too large/);
  });
  it("never puts the token or the Authorization header in an error", async () => {
    const failures: (() => Promise<Response>)[] = [
      async () => new Response(`denied ${TOKEN}`, { status: 403 }),
      async () => {
        throw new Error(`boom Bearer ${TOKEN}`);
      },
      async () => jsonResponse(`garbage ${TOKEN}`),
    ];
    for (const f of failures) {
      let message = "";
      try {
        await fetchStats({ env, days: 1, fetch: f as unknown as typeof fetch });
      } catch (error) {
        message = String((error as Error).message) + String((error as Error).stack ?? "");
        expect(error).toBeInstanceOf(StatsError);
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(TOKEN);
      expect(message).not.toMatch(/Bearer|Authorization/i);
    }
  });
});

describe("tools/stats.mjs", () => {
  const run = (args: string[], environment: Record<string, string>) =>
    new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = spawn(process.execPath, [join(ROOT, "tools", "stats.mjs"), ...args], { env: { PATH: process.env.PATH ?? "", ...environment }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => resolve({ code, out, err }));
    });
  it("exits 2 for a token in argv and says to use the environment, with no network", async () => {
    const r = await run(["--token", TOKEN], {});
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/in the environment/);
    expect(r.err + r.out).not.toContain(TOKEN);
  });
  it("exits 2 without the environment variables", async () => {
    const r = await run(["--days", "1"], {});
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/ONETIME_STATS_TOKEN|ONETIME_STATS_ACCOUNT_ID/);
  });
});
