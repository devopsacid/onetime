/** The kinds of link the usage counters tell apart (docs/plans/usage-counters.md). Closed set: shared by the web page, the CLI and the router. */
export const USAGE_KINDS = ["text", "text-pass", "file", "file-pass"] as const;
export type ClientKind = (typeof USAGE_KINDS)[number];

/** The kind a client reports for a link: a v1 link is a text without a passphrase. */
export function kindFor({ file, passphrase }: { file: boolean; passphrase: boolean }): ClientKind {
  return file ? (passphrase ? "file-pass" : "file") : passphrase ? "text-pass" : "text";
}
