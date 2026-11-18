import { ID_PATTERN, KEY_PATTERN } from "../shared/limits";

export interface SecretLink {
  id: string;
  key: string;
}

/** The id and key sit in the URL fragment, which browsers never send to a server. */
export function buildLink(origin: string, { id, key }: SecretLink): string {
  return `${origin}/#${id}.${key}`;
}

/** Returns null for an empty fragment and "invalid" for a damaged or cut-off link. */
export function parseFragment(hash: string): SecretLink | "invalid" | null {
  const fragment = hash.replace(/^#/, "");
  if (fragment === "") return null;
  const [id, key, ...rest] = fragment.split(".");
  if (rest.length > 0 || !id || !key || !ID_PATTERN.test(id) || !KEY_PATTERN.test(key)) return "invalid";
  return { id, key };
}
