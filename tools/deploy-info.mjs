#!/usr/bin/env node
// Deploys dist-info/ to the Pages project `onetimepass-info` (static only: no Functions, no D1).
// `wrangler pages deploy` picks up `functions/` from its working directory and finds `wrangler.jsonc` by searching the
// parent directories, so wrangler runs with a fresh empty working directory outside the repo. The project already
// exists (created once by the owner). Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment.
// Usage: node tools/deploy-info.mjs [--commit <40-hex sha>]   (default: git rev-parse HEAD)
// In a git checkout refuses a dirty tree; from a `git archive` (no .git) it needs --commit. It runs the info check-dist assertions before uploading; dist-info/ may not hold _worker.js.
// See docs/plans/info-origin-split.md. Deploy the commit whose `pnpm check` is green, info first, then the app.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const INFO_PROJECT = "onetimepass-info";
const FORBIDDEN = ["_routes.json", "index.html", "command-line.html", "manifest.webmanifest", "_worker.js", "functions", "cli", "wrangler.jsonc", "wrangler.toml"];
const REQUIRED = ["how-it-works.html", "privacy.html", "terms.html", "404.html", "_headers", "_redirects"];

/** Throws unless `dir` looks like the info build: its pages present, nothing of the app or a Function in it. */
export function assertInfoDist(dir) {
  if (!existsSync(dir)) throw new Error(`${dir} does not exist (run pnpm build first)`);
  const names = new Set(readdirSync(dir));
  for (const name of FORBIDDEN) if (names.has(name)) throw new Error(`${dir} contains ${name}: this is not the info build`);
  for (const name of REQUIRED) if (!names.has(name)) throw new Error(`${dir} has no ${name}`);
}

/**
 * In a git checkout: refuses unless the tree is clean (nothing uncommitted or untracked: the deployed commit hash must
 * describe what is uploaded). Outside a git repository (a clean `git archive`, the documented flow) it goes on only when
 * the caller passed `commit`, a 40-hex sha, and says so through `note`. Either way the info check-dist assertions must
 * pass on dist-info/. `run` is spawnSync-shaped.
 */
export function preflight(repo, run = (command, args) => spawnSync(command, args, { cwd: repo, encoding: "utf8" }), { commit, note = () => {} } = {}) {
  const git = run("git", ["status", "--porcelain"]);
  if (git.status === 0) {
    if (String(git.stdout ?? "").trim() !== "") throw new Error("the git tree has uncommitted or untracked changes (git status --porcelain is not empty); commit or remove them first");
  } else if (/^[0-9a-f]{40}$/.test(commit ?? "")) {
    note(`not a git checkout: treating this as an archive of commit ${commit} (taken from --commit)`);
  } else {
    throw new Error(`git status failed: ${String(git.stderr ?? "").trim()}; outside a git repository (an archive) pass --commit <40-hex sha>`);
  }
  const check = run(process.execPath, [join(repo, "tools", "check-dist.mjs"), "dist-info", "--profile", "info"]);
  if (check.status !== 0) throw new Error(`check-dist (info) failed:\n${String(check.stdout ?? "")}${String(check.stderr ?? "")}`);
}

/** The command to run and the parent of its temporary working directory. Pure apart from path arithmetic. */
export function deployPlan({ repo, sha, tmpBase }) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("the commit hash must be 40 hex characters");
  const root = resolve(repo);
  const base = resolve(tmpBase);
  if (base === root || base.startsWith(root + sep)) throw new Error("the working directory must be outside the repository");
  return {
    command: join(root, "node_modules", ".bin", "wrangler"),
    args: ["pages", "deploy", join(root, "dist-info"), "--project-name", INFO_PROJECT, "--branch", "main", "--commit-hash", sha, "--commit-dirty=false"],
    cwdParent: base,
  };
}

function main() {
  const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const flag = process.argv.indexOf("--commit");
  let sha = flag !== -1 ? process.argv[flag + 1] ?? "" : "";
  const explicit = flag !== -1;
  if (!explicit) {
    const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" });
    sha = r.status === 0 ? r.stdout.trim() : "";
  }
  const tmpBase = join(homedir(), ".tmp");
  mkdirSync(tmpBase, { recursive: true });
  preflight(repo, undefined, { commit: explicit ? sha : undefined, note: (m) => console.log(`deploy-info: ${m}`) });
  assertInfoDist(join(repo, "dist-info"));
  const plan = deployPlan({ repo, sha, tmpBase });
  const cwd = mkdtempSync(join(plan.cwdParent, "onetime-info-deploy-"));
  try {
    const r = spawnSync(plan.command, plan.args, { cwd, stdio: "inherit" });
    process.exitCode = r.status ?? 1;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`deploy-info: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
