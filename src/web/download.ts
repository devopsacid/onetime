import { safeFileName } from "./filename";

/**
 * The only module that may create object URLs (test/node/no-object-url.test.ts). The bytes always travel in a Blob of type
 * application/octet-stream and only ever reach a user-clicked `<a download>`: never src, iframe, window.open or location.
 * Rendering decrypted HTML or SVG on this origin would be stored XSS against the secret page.
 */
export interface DownloadAnchor {
  href: string;
  download: string;
}

export interface UrlApi {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

export interface Download {
  /** Revokes the URL, clears the anchor and zeroes the decrypted bytes. Safe to call twice. */
  release(): void;
}

export function createDownload(
  bytes: Uint8Array,
  name: string,
  anchor: DownloadAnchor,
  urls: UrlApi = URL,
): Download {
  const url = urls.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" }));
  anchor.href = url;
  anchor.download = safeFileName(name);
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      urls.revokeObjectURL(url);
      anchor.href = "";
      anchor.download = "";
      bytes.fill(0);
    },
  };
}
