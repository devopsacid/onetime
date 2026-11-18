import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const out = new URL("../dist/cli/", import.meta.url);
await mkdir(out, { recursive: true });

await build({
  entryPoints: [new URL("../cli/main.ts", import.meta.url).pathname],
  outfile: new URL("onetime.mjs", out).pathname,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  define: { __VERSION__: JSON.stringify(version) },
  legalComments: "none",
});
await chmod(new URL("onetime.mjs", out), 0o755);
// Windows does not use the shebang: this shim runs the bundle with node.
await writeFile(new URL("onetime.cmd", out), '@node "%~dp0onetime.mjs" %*\r\n');
