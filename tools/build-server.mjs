import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

// Usage: node tools/build-server.mjs [outfile]   (default dist-server/server.mjs)
const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const outfile = resolve(process.argv[2] ?? new URL("../dist-server/server.mjs", import.meta.url).pathname);
await mkdir(dirname(outfile), { recursive: true });

await build({
  entryPoints: [new URL("../server/main.ts", import.meta.url).pathname],
  outfile,
  bundle: true,
  platform: "node", // node:* modules stay external
  format: "esm",
  target: "node22",
  define: { __VERSION__: JSON.stringify(version) },
  legalComments: "none",
});
