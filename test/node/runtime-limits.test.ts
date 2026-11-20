import { describe, expect, it } from "vitest";
import { MAX_TEXT_BLOB_BYTES } from "../../src/shared/limits";
import { blobLimit } from "../../src/worker/index";

describe("blobLimit", () => {
  it("never goes below a text blob, however small maxFileBytes is", () => {
    expect(blobLimit({ maxFileBytes: 1000 })).toBe(MAX_TEXT_BLOB_BYTES);
    expect(blobLimit({ maxFileBytes: 1 })).toBe(MAX_TEXT_BLOB_BYTES);
    expect(blobLimit({ maxFileBytes: 16_000 })).toBe(MAX_TEXT_BLOB_BYTES);
  });
  it("follows the file blob above that, and is the text blob when files are off", () => {
    expect(blobLimit({ maxFileBytes: 16_001 })).toBe(65_954);
    expect(blobLimit({})).toBe(262_562);
    expect(blobLimit({ maxFileBytes: 0 })).toBe(MAX_TEXT_BLOB_BYTES);
  });
});
