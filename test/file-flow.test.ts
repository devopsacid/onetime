import { describe, expect, it } from "vitest";
import { ApiError } from "../src/web/api";
import { MAX_FILE_BYTES } from "../src/shared/limits";
import {
  FILE_TTL_VALUES,
  checkFileSize,
  describeFile,
  fileCreateError,
  progressPercent,
  ttlOptionsFor,
  uploadLabel,
} from "../src/web/file-flow";

describe("checkFileSize", () => {
  it("accepts 1 byte and the limit, refuses 0 and one over, before anything is read", () => {
    expect(checkFileSize(1)).toBeNull();
    expect(checkFileSize(MAX_FILE_BYTES)).toBeNull();
    expect(checkFileSize(0)).toBe("The file is empty.");
    expect(checkFileSize(MAX_FILE_BYTES + 1)).toBe("Files can be at most 128.0 KB.");
  });
});

describe("ttlOptionsFor", () => {
  it("offers only 1 hour and 1 day for files, keeps everything for text", () => {
    expect(FILE_TTL_VALUES).toEqual([3600, 86400]);
    const all = [3600, 86400, 604800];
    expect(ttlOptionsFor("file", all)).toEqual([3600, 86400]);
    expect(ttlOptionsFor("text", all)).toEqual(all);
  });
});

describe("fileCreateError", () => {
  it("maps 413 and 503 for files, leaves other errors and text alone", () => {
    expect(fileCreateError(new ApiError(413, "x"), true)).toBe("This server does not accept files this large.");
    expect(fileCreateError(new ApiError(503, "x"), true)).toBe("There is no room for files right now. Try again later or send a smaller file.");
    expect(fileCreateError(new ApiError(503, "x"), false)).toBeNull();
    expect(fileCreateError(new ApiError(409, "x", 3600), true)).toBeNull();
    expect(fileCreateError(new TypeError("offline"), true)).toBeNull();
  });
});

describe("progress and labels", () => {
  it("computes a clamped whole percentage and null when the total is unknown", () => {
    expect(progressPercent(50, 200)).toBe(25);
    expect(progressPercent(300, 200)).toBe(100);
    expect(progressPercent(5, 0)).toBeNull();
    expect(progressPercent(5, null)).toBeNull();
  });
  it("labels the upload with the size", () => {
    expect(uploadLabel(MAX_FILE_BYTES)).toBe("Uploading 128.0 KB…");
  });
});

describe("describeFile", () => {
  it("returns display strings and the risky flag", () => {
    expect(describeFile({ name: "setup.exe", type: "application/x-msdownload", size: 2048 })).toEqual({
      name: "setup.exe",
      size: "2.0 KB",
      type: "application/x-msdownload",
      risky: true,
    });
    expect(describeFile({ name: "a.txt", type: "", size: 1 })).toEqual({ name: "a.txt", size: "1 byte", type: "", risky: false });
  });
});
