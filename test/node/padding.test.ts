import { describe, expect, it } from "vitest";
import { MAX_SECRET_BYTES, V2_BUCKETS } from "../../src/shared/limits";
import { pad, unpad } from "../../src/web/padding";

describe("buckets", () => {
  it("are 256 B, 1 KiB, 4 KiB and the largest secret plus the length prefix", () => {
    expect([...V2_BUCKETS]).toEqual([256, 1024, 4096, MAX_SECRET_BYTES + 4]);
  });
});

describe("pad", () => {
  const cases: Array<[number, number]> = [
    [0, 256],
    [252, 256],
    [253, 1024],
    [1020, 1024],
    [1021, 4096],
    [4092, 4096],
    [4093, 16388],
    [16384, 16388],
  ];
  for (const [length, total] of cases) {
    it(`puts a ${length}-byte secret in a ${total}-byte block`, () => {
      const secret = new Uint8Array(length).fill(0x61);
      const padded = pad(secret);
      expect(padded.length).toBe(total);
      expect(new DataView(padded.buffer, padded.byteOffset).getUint32(0, false)).toBe(length);
      expect(padded.subarray(4, 4 + length)).toEqual(secret);
      expect(padded.subarray(4 + length).every((b) => b === 0)).toBe(true);
    });
  }

  it("refuses a secret above the maximum", () => {
    expect(() => pad(new Uint8Array(MAX_SECRET_BYTES + 1))).toThrow();
  });

  it("round trips every boundary", () => {
    for (const length of [0, 1, 251, 252, 253, 1019, 1020, 1021, 4091, 4092, 4093, 16384]) {
      const secret = crypto.getRandomValues(new Uint8Array(Math.min(length, 65536)));
      expect(unpad(pad(secret))).toEqual(secret);
    }
  });
});

describe("unpad", () => {
  function block(length: number, total: number): Uint8Array {
    const out = new Uint8Array(total);
    new DataView(out.buffer).setUint32(0, length, false);
    out.fill(0x62, 4, 4 + length);
    return out;
  }

  it("accepts a well-formed block", () => {
    expect(unpad(block(5, 256))).toEqual(new Uint8Array(5).fill(0x62));
  });

  it("rejects nonzero padding", () => {
    const b = block(5, 256);
    b[200] = 1;
    expect(() => unpad(b)).toThrow();
  });

  it("rejects a length that does not fit the block", () => {
    expect(() => unpad(block(253, 256))).toThrow();
    const b = block(0, 256);
    new DataView(b.buffer).setUint32(0, 0xffffffff, false);
    expect(() => unpad(b)).toThrow();
  });

  it("rejects a total size that is not a bucket", () => {
    expect(() => unpad(block(5, 255))).toThrow();
    expect(() => unpad(block(5, 257))).toThrow();
    expect(() => unpad(new Uint8Array(0))).toThrow();
    expect(() => unpad(new Uint8Array(3))).toThrow();
  });
});
