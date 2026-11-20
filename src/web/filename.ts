/** File name and type handling shared by the web page and the CLI. DOM-free. See docs/plans/file-transfer.md A-3. */

const FALLBACK_NAME = "onetime-file.bin";
const MAX_NAME_BYTES = 200;

const encoder = new TextEncoder();
const byteLength = (text: string): number => encoder.encode(text).length;

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const RESERVED_CHARS = /[<>:"|?*]/g;
const EDGE_DOTS_SPACES = /^[ .]+|[ .]+$/g;
const TRAILING_DOTS_SPACES = /[ .]+$/;
const RESERVED_STEM = /^(?:con|prn|aux|nul|(?:com|lpt)[0-9¹²³])$/i;
const EXTENSION = /\.[A-Za-z0-9]{1,16}$/;

function truncate(name: string): string {
  if (byteLength(name) <= MAX_NAME_BYTES) return name;
  const ext = EXTENSION.exec(name)?.[0] ?? "";
  const stem = name.slice(0, name.length - ext.length);
  let budget = MAX_NAME_BYTES - ext.length;
  let kept = "";
  for (const char of stem) {
    const size = byteLength(char);
    if (size > budget) break;
    kept += char;
    budget -= size;
  }
  kept = kept.replace(TRAILING_DOTS_SPACES, "");
  return (kept === "" ? "_" : kept) + ext;
}

/** A name that is safe to use as a file name on Linux, macOS and Windows: no path, no control or bidi characters, at most 200 bytes. */
export function safeFileName(raw: string): string {
  let name = raw.normalize("NFC");
  name = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  name = name.replace(INVISIBLE, "").replace(RESERVED_CHARS, "_").replace(EDGE_DOTS_SPACES, "");
  if (name === "") return FALLBACK_NAME;
  if (RESERVED_STEM.test(name.split(".")[0]!)) name = `_${name}`;
  return truncate(name);
}

const RISKY = new Set(
  (
    "exe msi msix appx bat cmd com scr pif cpl ps1 psm1 vbs vbe js jse wsf wsh hta lnk url dll sys jar app dmg pkg command " +
    "sh bash zsh csh run bin apk ipa iso img vhd vhdx deb rpm docm xlsm pptm dotm xlam html htm xhtml svg mht mhtml shtml xml reg scf inf"
  ).split(" "),
);

/** True if the file could run code or open as an active document: its last extension is on the list. */
export function riskyFile(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return RISKY.has(name.slice(dot + 1).toLowerCase());
}

const MIME = /^[a-z0-9][a-z0-9.+-]{0,62}\/[a-z0-9][a-z0-9.+-]{0,62}$/;

/** A clean "type/subtype" or "". Used as display text only, never as a Blob type and never to choose behaviour. */
export function cleanMime(raw: string): string {
  const type = raw.split(";")[0]!.trim().toLowerCase();
  return MIME.test(type) ? type : "";
}

/** "412 bytes", "15.6 KB", "1.0 MB" (1 KB = 1,024 bytes). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} ${n === 1 ? "byte" : "bytes"}`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
