import { describe, expect, it } from "vitest";
import indexSource from "../src/worker/index.ts?raw";
import storeSource from "../src/worker/store.ts?raw";
import usageSource from "../src/worker/usage.ts?raw";
import sharedUsageSource from "../src/shared/usage.ts?raw";

// The router and the store interface run in workerd and in Node, so they must not name either runtime.
describe("shared router modules", () => {
  it.each([
    ["src/worker/index.ts", indexSource],
    ["src/worker/store.ts", storeSource],
    ["src/worker/usage.ts", usageSource],
    ["src/shared/usage.ts", sharedUsageSource],
  ])("%s imports nothing from node: or cloudflare:", (_name, source) => {
    const specifiers = [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!);
    expect(specifiers.filter((s) => /^(node|cloudflare):/.test(s))).toEqual([]);
  });

  it("the router does not touch Cloudflare globals or a database binding", () => {
    expect(indexSource).not.toMatch(/Cloudflare\.|ExecutionContext|\.prepare\(/);
  });

  it("the usage module does not name Analytics Engine", () => {
    expect(indexSource + usageSource).not.toMatch(/writeDataPoint|AnalyticsEngine/);
  });

  it("the router hands the sink only string literals or a parseKind result", () => {
    const calls = [...indexSource.matchAll(/safeCount\(([^)]*(?:\([^)]*\)[^)]*)*)\)/g)].map((m) => m[1]!);
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const args of calls) {
      expect(args).toMatch(/^\s*usage,\s*"(view|create|reveal|gone)",\s*("app"|kind)\s*$/);
    }
    // `kind` is only ever assigned from parseKind.
    expect([...indexSource.matchAll(/\bkind\s*=\s*([^;\n]+)/g)].map((m) => m[1]!.trim())).toSatisfy((all: string[]) => all.length > 0 && all.every((v) => /^parseKind\(/.test(v)));
  });
});
