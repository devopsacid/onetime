import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { readProfileEnv } from "./site-profile.mjs";

const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
// ONETIME_SITE=selfhost builds into dist-selfhost/ and makes the instance's own origin the default server.
const site = readProfileEnv();
const out = new URL(`../${site.outDir}/cli/`, import.meta.url);
await mkdir(out, { recursive: true });

await build({
  entryPoints: [new URL("../cli/main.ts", import.meta.url).pathname],
  outfile: new URL("onetime.mjs", out).pathname,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: "#!/usr/bin/env node\n// onetime CLI - MIT License, Copyright (c) 2026 Michal Maxian. https://onetimepass.pages.dev" },
  define: {
    __VERSION__: JSON.stringify(version),
    ...(site.profile === "selfhost" ? { __DEFAULT_SERVER__: JSON.stringify(site.origin) } : {}),
  },
  legalComments: "none",
});
await chmod(new URL("onetime.mjs", out), 0o755);
// Checksum in sha256sum format, so people can verify the download.
const bundle = await readFile(new URL("onetime.mjs", out));
const digest = createHash("sha256").update(bundle).digest("hex");
await writeFile(new URL("onetime.mjs.sha256", out), `${digest}  onetime.mjs\n`);
// Windows does not use the shebang: this shim runs the bundle with node.
await writeFile(new URL("onetime.cmd", out), '@node "%~dp0onetime.mjs" %*\r\n');
