import type { Plugin } from "vite";
export function siteProfile(env?: Record<string, string | undefined>): Plugin;
export function readProfileEnv(env?: Record<string, string | undefined>): {
  profile: "onetimepass" | "selfhost";
  outDir: string;
  origin?: string;
  operatorName?: string;
  operatorContact?: string;
  indexable?: boolean;
};
