import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(import.meta.dirname, "../../src/web");
const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));

describe("decrypted files stay out of the page", () => {
  it("createObjectURL and revokeObjectURL appear only in download.ts", () => {
    const offenders = files.filter((f) => f !== "download.ts" && /(create|revoke)ObjectURL/.test(readFileSync(join(dir, f), "utf8")));
    expect(offenders).toEqual([]);
    expect(readFileSync(join(dir, "download.ts"), "utf8")).toMatch(/createObjectURL/);
  });

  it("no src/web file assigns innerHTML, outerHTML or uses insertAdjacentHTML, document.write or window.open", () => {
    const offenders = files.filter((f) => /\.(innerHTML|outerHTML)\s*[+]?=|insertAdjacentHTML|document\.write|window\.open\s*\(/.test(readFileSync(join(dir, f), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("no src/web file sets a blob: or data: URL on a media or frame element", () => {
    // analytics.ts sets the gtag script src (info pages only, a fixed https URL).
    const offenders = files.filter((f) => f !== "analytics.ts" && /\.(src|srcdoc|data)\s*=/.test(readFileSync(join(dir, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
