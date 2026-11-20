import { describe, expect, it } from "vitest";
import { normalizePassphrase, validatePassphrase } from "../../src/web/passphrase";

describe("normalizePassphrase", () => {
  it("applies NFKC, so full-width forms match the plain ones", () => {
    expect(normalizePassphrase("ｐａｓｓｗｏｒｄ１２")).toBe("password12");
  });
  it("composes accents", () => {
    expect(normalizePassphrase("é")).toBe("é");
  });
  it("trims both sides but keeps inner spaces", () => {
    expect(normalizePassphrase("  \tcorrect horse \n")).toBe("correct horse");
  });
});

describe("validatePassphrase", () => {
  const ok = (text: string) => expect(validatePassphrase(text)).toBeNull();
  it("counts code points: 7 too short, 8 fine, 256 fine, 257 too long", () => {
    expect(validatePassphrase("a".repeat(7))).toBe("too-short");
    ok("a".repeat(8));
    ok("a".repeat(256));
    expect(validatePassphrase("a".repeat(257))).toBe("too-long");
  });
  it("counts an astral character once", () => {
    expect(validatePassphrase("😀".repeat(7))).toBe("too-short");
    ok("😀".repeat(8));
    ok("😀".repeat(256));
    expect(validatePassphrase("😀".repeat(257))).toBe("too-long");
  });
  it("judges the normalised value", () => {
    expect(validatePassphrase("   abcdefg   ")).toBe("too-short");
    ok("ｐａｓｓｗｏｒｄ１２");
  });
  it("refuses C0, DEL and C1 control characters", () => {
    for (const code of [0x00, 0x07, 0x0a, 0x1f, 0x7f, 0x80, 0x85, 0x9f]) {
      expect(validatePassphrase(`abcd${String.fromCharCode(code)}efgh`)).toBe("control");
    }
    ok("abcd efgh".replace(" ", " "));
  });
});
