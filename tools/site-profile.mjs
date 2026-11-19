// Vite plugin for the two site profiles (docs/plans/self-host.md section 3.5).
//   ONETIME_SITE=onetimepass (default): the owner's Pages build, output dist/.
//   ONETIME_SITE=selfhost: output dist-selfhost/. Needs ONETIME_ORIGIN; optional ONETIME_OPERATOR_NAME,
//   ONETIME_OPERATOR_CONTACT and ONETIME_INDEXABLE=1.
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  headersForSelfhost,
  operatorContactHtml,
  operatorNameHtml,
  parseOrigin,
  robotsForSelfhost,
  sitemapForSelfhost,
  transformHtml,
} from "./site-profile-core.mjs";

/** Reads and validates the build environment. Throws on a bad profile or value. */
export function readProfileEnv(env = process.env) {
  const site = env.ONETIME_SITE === undefined || env.ONETIME_SITE === "" ? "onetimepass" : env.ONETIME_SITE;
  if (site !== "onetimepass" && site !== "selfhost") throw new Error(`ONETIME_SITE must be "onetimepass" or "selfhost" (got ${JSON.stringify(site)})`);
  if (site === "onetimepass") return { profile: "onetimepass", outDir: "dist" };
  const origin = parseOrigin(env.ONETIME_ORIGIN);
  operatorNameHtml(env.ONETIME_OPERATOR_NAME);
  operatorContactHtml(env.ONETIME_OPERATOR_CONTACT);
  return {
    profile: "selfhost",
    outDir: "dist-selfhost",
    origin,
    operatorName: env.ONETIME_OPERATOR_NAME,
    operatorContact: env.ONETIME_OPERATOR_CONTACT,
    indexable: env.ONETIME_INDEXABLE === "1",
  };
}

export function siteProfile(env = process.env) {
  const settings = readProfileEnv(env);
  let outDir = settings.outDir;
  return {
    name: "onetime-site-profile",
    config(config) {
      const root = config.root ?? process.cwd();
      outDir = resolve(root, settings.outDir);
      return { define: { __GA_ENABLED__: settings.profile === "onetimepass" }, build: { outDir: settings.outDir } };
    },
    transformIndexHtml: {
      order: "pre",
      handler: (html) => transformHtml(html, settings),
    },
    async closeBundle() {
      if (settings.profile !== "selfhost") return;
      const read = (name) => readFile(join(outDir, name), "utf8");
      await writeFile(join(outDir, "_headers"), headersForSelfhost(await read("_headers")));
      await writeFile(join(outDir, "robots.txt"), robotsForSelfhost(await read("robots.txt"), settings));
      if (settings.indexable) await writeFile(join(outDir, "sitemap.xml"), sitemapForSelfhost(await read("sitemap.xml"), settings.origin));
      else await rm(join(outDir, "sitemap.xml"), { force: true });
      await writeFile(join(outDir, "_selfhost.json"), `${JSON.stringify({ origin: settings.origin })}\n`);
    },
  };
}
