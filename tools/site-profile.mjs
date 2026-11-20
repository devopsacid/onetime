// Vite plugin for the three site profiles (docs/plans/self-host.md section 3.5, docs/plans/info-origin-split.md).
//   ONETIME_SITE=onetimepass (default): the owner's app site (Pages project onetimepass), output dist/.
//   ONETIME_SITE=info: the owner's info site (Pages project onetimepass-info, static only), output dist-info/.
//   ONETIME_SITE=selfhost: output dist-selfhost/. Needs ONETIME_ORIGIN; optional ONETIME_OPERATOR_NAME,
//   ONETIME_OPERATOR_CONTACT and ONETIME_INDEXABLE=1.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  headersForInfo,
  headersForSelfhost,
  INFO_ORIGIN,
  OWNER_ORIGIN,
  redirectsForApp,
  redirectsForInfo,
  robotsForInfo,
  sitemapForSite,
  operatorContactHtml,
  operatorNameHtml,
  parseOrigin,
  securityTxtForPages,
  securityTxtForSelfhost,
  robotsForSelfhost,
  sitemapForSelfhost,
  transformHtml,
} from "./site-profile-core.mjs";

/** Rollup inputs (HTML pages) of a profile. */
export function inputsFor(profile) {
  const all = { main: "index.html", howItWorks: "how-it-works.html", commandLine: "command-line.html", privacy: "privacy.html", terms: "terms.html", notFound: "404.html" };
  if (profile === "selfhost") return all;
  if (profile === "onetimepass") return { main: all.main, commandLine: all.commandLine, notFound: all.notFound };
  if (profile === "info") return { howItWorks: all.howItWorks, privacy: all.privacy, terms: all.terms, notFound: all.notFound };
  throw new Error(`unknown profile ${profile}`);
}

/** Reads and validates the build environment. Throws on a bad profile or value. */
export function readProfileEnv(env = process.env) {
  const site = env.ONETIME_SITE === undefined || env.ONETIME_SITE === "" ? "onetimepass" : env.ONETIME_SITE;
  if (site !== "onetimepass" && site !== "info" && site !== "selfhost") {
    throw new Error(`ONETIME_SITE must be "onetimepass", "info" or "selfhost" (got ${JSON.stringify(site)})`);
  }
  if (site === "onetimepass") return { profile: "onetimepass", outDir: "dist" };
  if (site === "info") return { profile: "info", outDir: "dist-info" };
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
  let rootDir = process.cwd();
  return {
    name: "onetime-site-profile",
    config(config) {
      const root = config.root ?? process.cwd();
      rootDir = root;
      outDir = resolve(root, settings.outDir);
      const site = settings.profile === "onetimepass" ? "app" : settings.profile;
      return {
        define: { __SITE__: JSON.stringify(site) },
        build: { outDir: settings.outDir, rollupOptions: { input: inputsFor(settings.profile) } },
      };
    },
    transformIndexHtml: {
      order: "pre",
      handler: (html) => transformHtml(html, settings),
    },
    async closeBundle() {
      const writeSecurityTxt = async (text) => {
        if (text === null) return;
        await mkdir(join(outDir, ".well-known"), { recursive: true });
        await writeFile(join(outDir, ".well-known", "security.txt"), text);
      };
      const read = (name) => readFile(join(outDir, name), "utf8");
      if (settings.profile !== "selfhost") {
        // The published address is read from the privacy source (the app build has no privacy page), so the two never differ.
        const privacyHtml = await readFile(join(rootDir, "privacy.html"), "utf8");
        const origin = settings.profile === "info" ? INFO_ORIGIN : OWNER_ORIGIN;
        await writeSecurityTxt(securityTxtForPages({ privacyHtml, now: new Date(), origin }));
        if (settings.profile === "onetimepass") {
          await writeFile(join(outDir, "_redirects"), redirectsForApp());
          await writeFile(join(outDir, "sitemap.xml"), sitemapForSite(await read("sitemap.xml"), OWNER_ORIGIN));
          return;
        }
        await writeFile(join(outDir, "_redirects"), redirectsForInfo());
        await writeFile(join(outDir, "_headers"), headersForInfo(await read("_headers")));
        await writeFile(join(outDir, "robots.txt"), robotsForInfo());
        await writeFile(join(outDir, "sitemap.xml"), sitemapForSite(await read("sitemap.xml"), INFO_ORIGIN));
        await rm(join(outDir, "_routes.json"), { force: true });
        await rm(join(outDir, "manifest.webmanifest"), { force: true });
        return;
      }
      await writeSecurityTxt(securityTxtForSelfhost({ origin: settings.origin, contact: settings.operatorContact, now: new Date() }));
      await writeFile(join(outDir, "_headers"), headersForSelfhost(await read("_headers"), { indexable: settings.indexable }));
      await writeFile(join(outDir, "robots.txt"), robotsForSelfhost(await read("robots.txt"), settings));
      if (settings.indexable) await writeFile(join(outDir, "sitemap.xml"), sitemapForSelfhost(await read("sitemap.xml"), settings.origin));
      else await rm(join(outDir, "sitemap.xml"), { force: true });
      await writeFile(join(outDir, "_selfhost.json"), `${JSON.stringify({ origin: settings.origin })}\n`);
    },
  };
}
