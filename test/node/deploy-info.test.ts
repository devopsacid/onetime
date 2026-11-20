import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertInfoDist, deployPlan } from "../../tools/deploy-info.mjs";
import { ROOT, tempDir } from "./helpers";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function infoDist(root: string, extra: string[] = []): string {
  const dir = join(root, "dist-info");
  mkdirSync(dir, { recursive: true });
  for (const name of ["how-it-works.html", "privacy.html", "404.html", "_headers", "_redirects", ...extra]) writeFileSync(join(dir, name), "x\n");
  return dir;
}

describe("assertInfoDist", () => {
  it("accepts an info build", () => {
    const t = tempDir("deploy-info-");
    expect(() => assertInfoDist(infoDist(t.path))).not.toThrow();
  });
  it.each(["_routes.json", "index.html", "command-line.html", "manifest.webmanifest"])("refuses a dist that contains %s", (name) => {
    const t = tempDir("deploy-info-");
    expect(() => assertInfoDist(infoDist(t.path, [name]))).toThrow(name);
  });
  it("refuses a dist with a functions directory or a missing page", () => {
    const t = tempDir("deploy-info-");
    const dir = infoDist(t.path);
    mkdirSync(join(dir, "functions"));
    expect(() => assertInfoDist(dir)).toThrow(/functions/);
    const u = tempDir("deploy-info-");
    expect(() => assertInfoDist(join(u.path, "missing"))).toThrow();
  });
});

describe("deployPlan", () => {
  const plan = deployPlan({ repo: ROOT, sha: SHA, tmpBase: join(tempDir("deploy-base-").path) });
  it("runs the repo's wrangler by absolute path with the fixed arguments", () => {
    expect(plan.command).toBe(join(ROOT, "node_modules", ".bin", "wrangler"));
    expect(plan.args).toEqual(["pages", "deploy", join(ROOT, "dist-info"), "--project-name", "onetimepass-info", "--branch", "main", "--commit-hash", SHA, "--commit-dirty=false"]);
  });
  it("uses a working directory outside the repo", () => {
    expect(plan.cwdParent.startsWith(ROOT)).toBe(false);
  });
  it("refuses a malformed commit hash and a temp base inside the repo", () => {
    expect(() => deployPlan({ repo: ROOT, sha: "main", tmpBase: "/tmp" })).toThrow(/commit/);
    expect(() => deployPlan({ repo: ROOT, sha: SHA, tmpBase: join(ROOT, "dist-info") })).toThrow(/outside/);
  });
});
