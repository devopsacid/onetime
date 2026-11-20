import { describe, expect, it } from "vitest";
import { MAX_FILE_BYTES } from "../../src/shared/limits";
import { decodeFilePayload, encodeFilePayload } from "../../src/web/file-payload";

const enc = new TextEncoder();

/** Hand-built payload: N, name, T, type, content (no validation, so tests can build bad ones). */
function raw(name: Uint8Array, type: Uint8Array, content: Uint8Array, nameLen = name.length, typeLen = type.length): Uint8Array {
  return Buffer.concat([Buffer.from([nameLen]), name, Buffer.from([typeLen]), type, content]);
}
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

describe("encodeFilePayload and decodeFilePayload", () => {
  it("lays out N, name, T, type, content exactly as the plan says", () => {
    const out = encodeFilePayload({ name: "a.txt", type: "text/plain", bytes: new Uint8Array([1, 2, 3]) });
    expect([...out]).toEqual([5, ...enc.encode("a.txt"), 10, ...enc.encode("text/plain"), 1, 2, 3]);
  });

  it("round trips name, type and content", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(5000));
    const back = decodeFilePayload(encodeFilePayload({ name: "résumé.pdf", type: "application/pdf", bytes }));
    expect(back.name).toBe("résumé.pdf");
    expect(back.type).toBe("application/pdf");
    expect(same(back.bytes, bytes)).toBe(true);
  });

  it("accepts an empty type", () => {
    const back = decodeFilePayload(encodeFilePayload({ name: "x.bin", type: "", bytes: new Uint8Array([9]) }));
    expect(back.type).toBe("");
  });

  it("the writer stores safeFileName(name) and cleanMime(type)", () => {
    const back = decodeFilePayload(encodeFilePayload({ name: "../../etc/pa‮sswd", type: "Text/HTML; charset=x", bytes: new Uint8Array(1) }));
    expect(back.name).toBe("pas" + "swd");
    expect(back.type).toBe("text/html");
    const odd = decodeFilePayload(encodeFilePayload({ name: "a.txt", type: "not a type", bytes: new Uint8Array(1) }));
    expect(odd.type).toBe("");
  });

  it("the writer refuses empty content and content above MAX_FILE_BYTES", () => {
    expect(() => encodeFilePayload({ name: "a", type: "", bytes: new Uint8Array(0) })).toThrow();
    expect(() => encodeFilePayload({ name: "a", type: "", bytes: new Uint8Array(MAX_FILE_BYTES + 1) })).toThrow();
    expect(() => encodeFilePayload({ name: "a", type: "", bytes: new Uint8Array(MAX_FILE_BYTES) })).not.toThrow();
  });

  it("the largest name (200 bytes) and type fit the 388-byte meta budget", () => {
    const out = encodeFilePayload({ name: "n".repeat(300) + ".pdf", type: "application/" + "x".repeat(50), bytes: new Uint8Array(1) });
    expect(out.length).toBeLessThanOrEqual(384 + 1);
  });
});

describe("decodeFilePayload rejects", () => {
  const ok = enc.encode("a.txt");
  const content = new Uint8Array([1, 2, 3]);

  it("a name length of 0", () => {
    expect(() => decodeFilePayload(raw(new Uint8Array(0), new Uint8Array(0), content))).toThrow();
  });
  it("a type length of 128", () => {
    expect(() => decodeFilePayload(raw(ok, new Uint8Array(128).fill(0x61), content))).toThrow();
  });
  it("a type length of 127 passes the length check", () => {
    const back = decodeFilePayload(raw(ok, new Uint8Array(127).fill(0x61), content));
    expect(back.type).toBe(""); // not a clean type, so not shown
  });
  it("a name length that overruns the payload", () => {
    expect(() => decodeFilePayload(raw(ok, new Uint8Array(0), content, 200))).toThrow();
  });
  it("a type length that overruns the payload", () => {
    expect(() => decodeFilePayload(raw(ok, new Uint8Array(0), content, ok.length, 100))).toThrow();
  });
  it("empty content", () => {
    expect(() => decodeFilePayload(raw(ok, new Uint8Array(0), new Uint8Array(0)))).toThrow();
  });
  it("content above MAX_FILE_BYTES", () => {
    expect(() => decodeFilePayload(raw(ok, new Uint8Array(0), new Uint8Array(MAX_FILE_BYTES + 1)))).toThrow();
  });
  it("a payload that ends inside the header", () => {
    expect(() => decodeFilePayload(new Uint8Array(0))).toThrow();
    expect(() => decodeFilePayload(new Uint8Array([3, 0x61, 0x62]))).toThrow();
    expect(() => decodeFilePayload(new Uint8Array([1, 0x61]))).toThrow();
  });
  it("an invalid UTF-8 name", () => {
    expect(() => decodeFilePayload(raw(new Uint8Array([0x61, 0xff, 0x62]), new Uint8Array(0), content))).toThrow();
    expect(() => decodeFilePayload(raw(new Uint8Array([0xc0, 0x80]), new Uint8Array(0), content))).toThrow();
  });
});

describe("decodeFilePayload does not trust name and type", () => {
  it("shows safeFileName(name), never the raw name", () => {
    const back = decodeFilePayload(raw(enc.encode("..\\..\\evil‮.exe"), new Uint8Array(0), new Uint8Array([1])));
    expect(back.name).toBe("evil.exe");
  });
  it("shows the type only if it is clean as it stands", () => {
    const clean = decodeFilePayload(raw(enc.encode("a"), enc.encode("image/png"), new Uint8Array([1])));
    expect(clean.type).toBe("image/png");
    const dirty = decodeFilePayload(raw(enc.encode("a"), enc.encode("Image/PNG"), new Uint8Array([1])));
    expect(dirty.type).toBe("");
    const params = decodeFilePayload(raw(enc.encode("a"), enc.encode("text/plain; x=1"), new Uint8Array([1])));
    expect(params.type).toBe("");
    const nonAscii = decodeFilePayload(raw(enc.encode("a"), new Uint8Array([0xff, 0xfe]), new Uint8Array([1])));
    expect(nonAscii.type).toBe("");
  });
});
