import { describe, expect, it } from "vitest";
import {
  BLOB_OVERHEAD_BYTES,
  FILE_BUCKETS,
  FILE_META_MAX,
  FILE_MAX_TTL_SECONDS,
  LARGE_MAX_TTL_SECONDS,
  MAX_BLOB_BYTES,
  MAX_FILE_BYTES,
  MAX_LARGE_STORED_BYTES,
  MAX_SECRET_BYTES,
  MAX_STORED_BYTES,
  MAX_TEXT_BLOB_BYTES,
  V2_BUCKETS,
  fileBlobBytes,
} from "../../src/shared/limits";
import { pad, unpad } from "../../src/web/padding";

describe("buckets", () => {
  it("are 256 B, 1 KiB, 4 KiB and the largest secret plus the length prefix", () => {
    expect([...V2_BUCKETS]).toEqual([256, 1024, 4096, MAX_SECRET_BYTES + 4]);
  });
});

describe("MAX_TEXT_BLOB_BYTES", () => {
  it("is the largest v2 text blob, 14 header bytes + the biggest text bucket + 16 tag bytes", () => {
    expect(MAX_TEXT_BLOB_BYTES).toBe(14 + V2_BUCKETS[V2_BUCKETS.length - 1]! + 16);
    expect(MAX_TEXT_BLOB_BYTES).toBe(16_418);
  });
  it("also covers the largest v1 blob (secret + 28)", () => {
    expect(MAX_TEXT_BLOB_BYTES).toBeGreaterThanOrEqual(MAX_SECRET_BYTES + BLOB_OVERHEAD_BYTES);
    expect(BLOB_OVERHEAD_BYTES).toBe(28);
  });
});

describe("file limits", () => {
  it("MAX_FILE_BYTES is 1 MiB and FILE_META_MAX is the 4-byte prefix plus 1 + 255 + 1 + 127", () => {
    expect(MAX_FILE_BYTES).toBe(1_048_576);
    expect(FILE_META_MAX).toBe(388);
  });
  it("FILE_BUCKETS are the three small text blocks, then doubling blocks that hold meta on top of the file", () => {
    expect([...FILE_BUCKETS]).toEqual([1024, 4096, 16_388, 65_924, 131_460, 262_532, 524_676, 1_048_964]);
  });
  it("MAX_BLOB_BYTES is the largest file blob, 1,048,994, and equals fileBlobBytes(1 MiB)", () => {
    expect(MAX_BLOB_BYTES).toBe(1_048_994);
    expect(fileBlobBytes(1024 * 1024)).toBe(1_048_994);
    expect(MAX_BLOB_BYTES).toBe(FILE_BUCKETS[FILE_BUCKETS.length - 1]! + 30);
  });
  it("fileBlobBytes gives the smallest blob whose block holds the file plus the meta", () => {
    expect(fileBlobBytes(1)).toBe(1054);
    expect(fileBlobBytes(636)).toBe(1054);
    expect(fileBlobBytes(637)).toBe(4126);
    expect(fileBlobBytes(16_000)).toBe(16_418);
    expect(fileBlobBytes(16_001)).toBe(65_954);
    expect(fileBlobBytes(256 * 1024)).toBe(262_562);
    expect(() => fileBlobBytes(1024 * 1024 + 1)).toThrow(RangeError);
    expect(() => fileBlobBytes(0)).toThrow(RangeError);
  });
  it("byte budgets and the TTL rule for large blobs", () => {
    expect(MAX_STORED_BYTES).toBe(400_000_000);
    expect(MAX_LARGE_STORED_BYTES).toBe(200_000_000);
    expect(LARGE_MAX_TTL_SECONDS).toBe(86_400);
    expect(FILE_MAX_TTL_SECONDS).toBe(86_400);
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

describe("pad and unpad with file buckets", () => {
  // A file with the largest possible meta (1 + 255 + 1 + 127 = 384 bytes) in front of N content bytes.
  const META = 384;
  const cases: Array<[number, number]> = [
    [636, 1024],
    [637, 4096],
    [3708, 4096],
    [3709, 16_388],
    [16_000, 16_388],
    [16_001, 65_924],
    [65_536, 65_924],
    [65_537, 131_460],
    [131_072, 131_460],
    [262_144, 262_532],
    [524_288, 524_676],
    [1024 * 1024, 1_048_964],
  ];
  for (const [file, block] of cases) {
    it(`puts a ${file}-byte file with maximal meta in a ${block}-byte block`, () => {
      const payload = new Uint8Array(META + file).fill(0x63);
      const padded = pad(payload, FILE_BUCKETS);
      expect(padded.length).toBe(block);
      expect(unpad(padded, FILE_BUCKETS, MAX_FILE_BYTES + META)).toEqual(payload);
    });
  }

  it("refuses a payload above the largest file block", () => {
    expect(() => pad(new Uint8Array(MAX_FILE_BYTES + META + 1), FILE_BUCKETS)).toThrow();
  });

  it("unpad refuses nonzero padding, a block size that is not a file bucket and a length above maxPayload", () => {
    const padded = pad(new Uint8Array(10).fill(1), FILE_BUCKETS);
    const dirty = padded.slice();
    dirty[dirty.length - 1] = 1;
    expect(() => unpad(dirty, FILE_BUCKETS, MAX_FILE_BYTES + META)).toThrow();
    expect(() => unpad(new Uint8Array(256), FILE_BUCKETS, MAX_FILE_BYTES + META)).toThrow();
    expect(() => unpad(padded, FILE_BUCKETS, 5)).toThrow();
  });

  it("text buckets still refuse a 1 KiB-plus-meta file block and the other way round", () => {
    const fileBlock = pad(new Uint8Array(20), FILE_BUCKETS); // 1,024 is a text bucket too
    expect(unpad(fileBlock)).toEqual(new Uint8Array(20));
    const big = pad(new Uint8Array(70_000), FILE_BUCKETS);
    expect(() => unpad(big)).toThrow();
  });
});
