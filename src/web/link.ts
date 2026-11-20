import { FORMAT_PATTERN, ID_PATTERN, KEY_PATTERN } from "../shared/limits";

export interface SecretLink {
  id: string;
  key: string;
  /** 1: `#<id>.<key>` (blob v1). 2: `#2.<id>.<key>`, `#2p.…`, `#2f.…` or `#2fp.…` (blob v2). */
  format: 1 | 2;
  /** Always false for format 1. */
  passphrase: boolean;
  /** The blob is a file (2f, 2fp). Always false for format 1. */
  file: boolean;
}

/** The id and key sit in the URL fragment, which browsers never send to a server. */
export function buildLink(origin: string, { id, key, format, passphrase, file }: SecretLink): string {
  if (format === 1) return `${origin}/#${id}.${key}`;
  return `${origin}/#2${file ? "f" : ""}${passphrase ? "p" : ""}.${id}.${key}`;
}

/** Returns null for an empty fragment and "invalid" for a damaged or cut-off link. */
export function parseFragment(hash: string): SecretLink | "invalid" | null {
  const fragment = hash.replace(/^#/, "");
  if (fragment === "") return null;
  const parts = fragment.split(".");
  if (parts.length === 2) {
    const [id, key] = parts as [string, string];
    if (!ID_PATTERN.test(id) || !KEY_PATTERN.test(key)) return "invalid";
    return { id, key, format: 1, passphrase: false, file: false };
  }
  if (parts.length === 3) {
    const [format, id, key] = parts as [string, string, string];
    if (!FORMAT_PATTERN.test(format) || !ID_PATTERN.test(id) || !KEY_PATTERN.test(key)) return "invalid";
    return { id, key, format: 2, passphrase: format.endsWith("p"), file: format.startsWith("2f") };
  }
  return "invalid";
}
