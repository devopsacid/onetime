import { describe, expect, it } from "vitest";
import indexSource from "../src/worker/index.ts?raw";
import storeSource from "../src/worker/store.ts?raw";

// The router and the store interface run in workerd and in Node, so they must not name either runtime.
describe("shared router modules", () => {
  it.each([
    ["src/worker/index.ts", indexSource],
    ["src/worker/store.ts", storeSource],
  ])("%s imports nothing from node: or cloudflare:", (_name, source) => {
    const specifiers = [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!);
    expect(specifiers.filter((s) => /^(node|cloudflare):/.test(s))).toEqual([]);
  });

  it("the router does not touch Cloudflare globals or a database binding", () => {
    expect(indexSource).not.toMatch(/Cloudflare\.|ExecutionContext|\.prepare\(/);
  });
});
