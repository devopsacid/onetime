/** The one fixed analytics event besides page_view: `cli_download` with an enum parameter. No free text, no ids. */
export type CliFile = "script" | "windows_shim" | "checksum";

export function cliDownloadKind(pathname: string): CliFile | null {
  switch (pathname) {
    case "/cli/onetime.mjs":
      return "script";
    case "/cli/onetime.cmd":
      return "windows_shim";
    case "/cli/onetime.mjs.sha256":
      return "checksum";
    default:
      return null;
  }
}
