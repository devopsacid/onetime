import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertInfoDist, deployPlan, preflight } from "../../tools/deploy-info.mjs";
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
  it("refuses a _worker.js file or directory (advanced-mode Worker)", () => {
    const t = tempDir("deploy-info-");
    expect(() => assertInfoDist(infoDist(t.path, ["_worker.js"]))).toThrow(/_worker\.js/);
    const u = tempDir("deploy-info-");
    const dir = infoDist(u.path);
    mkdirSync(join(dir, "_worker.js"));
    expect(() => assertInfoDist(dir)).toThrow(/_worker\.js/);
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

describe("preflight", () => {
  const ok = { status: 0, stdout: "", stderr: "" };
  function recorder(answers: Record<string, { status: number; stdout: string; stderr: string }>) {
    const calls: string[] = [];
    const run = (command: string, args: string[]) => {
      const line = [command, ...args].join(" ");
      calls.push(line);
      for (const [needle, answer] of Object.entries(answers)) if (line.includes(needle)) return answer;
      return ok;
    };
    return { calls, run };
  }

  it("passes on a clean tree and a green info check, running git status first and check-dist second", () => {
    const r = recorder({});
    expect(() => preflight(ROOT, r.run)).not.toThrow();
    expect(r.calls[0]).toBe("git status --porcelain");
    expect(r.calls[1]).toContain("check-dist.mjs");
    expect(r.calls[1]).toContain("dist-info");
    expect(r.calls[1]).toContain("--profile info");
    expect(r.calls).toHaveLength(2);
  });

  it.each([" M src/web/main.ts\n", "?? new-file\n", "A  staged\n"])("refuses a dirty tree (%j) before running any check", (porcelain) => {
    const r = recorder({ "status --porcelain": { status: 0, stdout: porcelain, stderr: "" } });
    expect(() => preflight(ROOT, r.run)).toThrow(/uncommitted|dirty/i);
    expect(r.calls).toHaveLength(1);
  });

  it("refuses when git itself fails", () => {
    const r = recorder({ "status --porcelain": { status: 128, stdout: "", stderr: "not a repo" } });
    expect(() => preflight(ROOT, r.run)).toThrow(/git status/);
  });

  it("outside a git repository accepts an explicit --commit sha (an archive), says so, and still runs check-dist", () => {
    const r = recorder({ "status --porcelain": { status: 128, stdout: "", stderr: "fatal: not a git repository" } });
    const notes: string[] = [];
    expect(() => preflight(ROOT, r.run, { commit: SHA, note: (m: string) => notes.push(m) })).not.toThrow();
    expect(r.calls.some((c) => c.includes("check-dist.mjs"))).toBe(true);
    expect(notes.join(" ")).toMatch(/archive/i);
  });
  it("outside a git repository refuses without an explicit commit, or with a malformed one", () => {
    const r = recorder({ "status --porcelain": { status: 128, stdout: "", stderr: "fatal: not a git repository" } });
    expect(() => preflight(ROOT, r.run)).toThrow(/git status|--commit/);
    expect(() => preflight(ROOT, r.run, { commit: "main" })).toThrow(/--commit/);
    expect(r.calls.some((c) => c.includes("check-dist.mjs"))).toBe(false);
  });
  it("in a git checkout a dirty tree is refused even with --commit", () => {
    const r = recorder({ "status --porcelain": { status: 0, stdout: " M x\n", stderr: "" } });
    expect(() => preflight(ROOT, r.run, { commit: SHA })).toThrow(/uncommitted/);
  });
  it("refuses when the info check-dist assertions fail", () => {
    const r = recorder({ "check-dist.mjs": { status: 1, stdout: "", stderr: "problem" } });
    expect(() => preflight(ROOT, r.run)).toThrow(/check-dist/);
  });
});
