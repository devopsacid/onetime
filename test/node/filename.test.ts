import { describe, expect, it } from "vitest";
import { cleanMime, formatBytes, riskyFile, safeFileName } from "../../src/web/filename";

const FALLBACK = "onetime-file.bin";
const bytes = (s: string) => new TextEncoder().encode(s).length;

describe("safeFileName: hostile names", () => {
  const table: Array<[string, string, string]> = [
    ["path traversal", "../../etc/passwd", "passwd"],
    ["windows traversal", "..\\..\\Windows\\x.dll", "x.dll"],
    ["drive letter", "C:evil.txt", "C_evil.txt"],
    ["NUL byte", "a\u0000b.txt", "ab.txt"],
    ["bidi override", "invoice‮txt.exe", "invoicetxt.exe"],
    ["CON", "CON", "_CON"],
    ["con.txt", "con.txt", "_con.txt"],
    ["LPT9.log", "LPT9.log", "_LPT9.log"],
    ["COM superscript one", "COM¹", "_COM¹"],
    ["hidden dotfile with spaces", "  .bashrc ", "bashrc"],
    ["trailing dot", "file.txt.", "file.txt"],
    ["reserved characters", 'a<b>:"c|d?e*.txt', "a_b___c_d_e_.txt"],
    ["accented name stays", "é.txt", "é.txt"],
    ["newline", "a\nb", "ab"],
    ["zero-width space only", "​", FALLBACK],
    ["dots only", "...", FALLBACK],
    ["slash only", "/", FALLBACK],
    ["empty", "", FALLBACK],
    ["double extension stays", "report.pdf.exe", "report.pdf.exe"],
    ["NFC normalisation", "é.txt", "é.txt"],
    ["DEL and C1 controls", "a\u007fb\u0085c", "abc"],
    ["soft hyphen, BOM, line separator", "a­b﻿c d", "abcd"],
    ["tag characters", "a\u{e0041}b", "ab"],
    ["trailing slash keeps nothing", "dir/", FALLBACK],
    ["AUX with extension in uppercase", "AUX.TAR.GZ", "_AUX.TAR.GZ"],
    ["COM0", "com0", "_com0"],
    ["not reserved: CONSOLE", "CONSOLE.txt", "CONSOLE.txt"],
  ];
  for (const [label, input, expected] of table) {
    it(label, () => {
      expect(safeFileName(input)).toBe(expected);
    });
  }

  it("cuts a 304-character name to 200 bytes and keeps .pdf", () => {
    const out = safeFileName("a".repeat(300) + ".pdf");
    expect(bytes(out)).toBe(200);
    expect(out.endsWith(".pdf")).toBe(true);
  });

  it("cuts a long multibyte name at a code point boundary", () => {
    const out = safeFileName("é".repeat(150));
    expect(bytes(out)).toBeLessThanOrEqual(200);
    expect(bytes(out)).toBeGreaterThan(190);
    expect(new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(out))).toBe(out);
    expect(out).toBe("é".repeat(out.length));
  });

  it("does not split an astral code point", () => {
    const out = safeFileName("\u{1f600}".repeat(60) + ".txt");
    expect(bytes(out)).toBeLessThanOrEqual(200);
    expect(out.endsWith(".txt")).toBe(true);
    expect(out).not.toMatch(/�/);
    expect([...out].every((c) => c === "\u{1f600}" || ".txt".includes(c))).toBe(true);
  });

  it("is idempotent on every table output", () => {
    for (const [, input] of table) {
      const once = safeFileName(input);
      expect(safeFileName(once)).toBe(once);
    }
  });

  it("never returns a separator, control or trailing dot or space, for random input", () => {
    for (let i = 0; i < 500; i++) {
      const raw = String.fromCodePoint(...Array.from({ length: 12 }, () => Math.floor(Math.random() * 0x3000)).filter((c) => c < 0xd800 || c > 0xdfff));
      const out = safeFileName(raw);
      expect(out).not.toMatch(/[\\/<>:"|?*]/);
      expect(out).not.toMatch(/\p{Cc}|\p{Cf}/u);
      expect(out).not.toMatch(/^[ .]|[ .]$/);
      expect(bytes(out)).toBeLessThanOrEqual(200);
      expect(out.length).toBeGreaterThan(0);
    }
  });
});

describe("riskyFile", () => {
  it("flags program, script, shortcut and active-document extensions, case-insensitively", () => {
    for (const name of ["setup.exe", "A.MSI", "x.bat", "run.sh", "s.ps1", "doc.docm", "page.html", "pic.svg", "a.jar", "disk.iso", "x.lnk", "app.apk", "t.reg"]) {
      expect(riskyFile(name), name).toBe(true);
    }
  });
  it("flags a double extension whose last part is risky", () => {
    expect(riskyFile("report.pdf.exe")).toBe(true);
  });
  it("does not flag plain documents, media or a risky word in the stem", () => {
    for (const name of ["report.pdf", "photo.jpg", "notes.txt", "exe", "exe.txt", "archive.zip", "noextension", "a.exe.txt"]) {
      expect(riskyFile(name), name).toBe(false);
    }
  });
});

describe("cleanMime", () => {
  it("keeps a clean type, lowercased, without parameters", () => {
    expect(cleanMime("Application/PDF")).toBe("application/pdf");
    expect(cleanMime("text/plain; charset=utf-8")).toBe("text/plain");
    expect(cleanMime(" image/svg+xml ")).toBe("image/svg+xml");
    expect(cleanMime("application/vnd.ms-excel")).toBe("application/vnd.ms-excel");
  });
  it("returns an empty string for anything else", () => {
    for (const raw of ["", "pdf", "a/b/c", "text/", "/plain", "text/pl ain", "text/<script>", "text/pl\nain", "é/x", "x".repeat(64) + "/y", "-a/b"]) {
      expect(cleanMime(raw), JSON.stringify(raw)).toBe("");
    }
  });
});

describe("formatBytes", () => {
  it("uses bytes below 1 KB, then one decimal place with 1,024 per step", () => {
    expect(formatBytes(0)).toBe("0 bytes");
    expect(formatBytes(1)).toBe("1 byte");
    expect(formatBytes(412)).toBe("412 bytes");
    expect(formatBytes(1023)).toBe("1023 bytes");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(16_000)).toBe("15.6 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1_572_864)).toBe("1.5 MB");
  });
});
