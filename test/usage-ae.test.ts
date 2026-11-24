import { describe, expect, it } from "vitest";
import functionSource from "../functions/api/[[path]].ts?raw";
import { analyticsEngineUsage } from "../src/worker/usage-ae";
import { noUsage } from "../src/worker/usage";

describe("analyticsEngineUsage", () => {
  it("writes exactly blobs [event, label] and indexes [event], nothing else", () => {
    const points: unknown[] = [];
    const usage = analyticsEngineUsage({ writeDataPoint: (p: unknown) => void points.push(p) } as unknown as AnalyticsEngineDataset);
    usage.count("create", "file-pass");
    usage.count("view", "app");
    expect(points).toEqual([
      { blobs: ["create", "file-pass"], indexes: ["create"] },
      { blobs: ["view", "app"], indexes: ["view"] },
    ]);
    for (const p of points) expect(Object.keys(p as object).sort()).toEqual(["blobs", "indexes"]);
  });

  it("is a no-op without a binding", () => {
    const usage = analyticsEngineUsage(undefined);
    expect(usage).toBe(noUsage);
    expect(() => usage.count("gone", "text")).not.toThrow();
  });

  it("swallows a throwing writeDataPoint", () => {
    const usage = analyticsEngineUsage({ writeDataPoint: () => { throw new Error("quota"); } } as unknown as AnalyticsEngineDataset);
    expect(() => usage.count("reveal", "text")).not.toThrow();
  });
});

describe("Pages Function wiring", () => {
  it("passes the adapter built from the USAGE binding to the router", () => {
    expect(functionSource).toContain("usage: analyticsEngineUsage(context.env.USAGE)");
  });
});
