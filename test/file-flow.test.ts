import { describe, expect, it } from "vitest";
import { ApiError } from "../src/web/api";
import { MAX_FILE_BYTES } from "../src/shared/limits";
import {
  checkFileSize,
  fileTtlValues,
  formatLifetime,
  pickFileTtl,
  describeFile,
  fileCreateError,
  progressPercent,
  ttlOptionsFor,
  uploadLabel,
} from "../src/web/file-flow";

describe("checkFileSize", () => {
  it("accepts 1 byte and the limit, refuses 0 and one over, before anything is read", () => {
    expect(checkFileSize(1, MAX_FILE_BYTES)).toBeNull();
    expect(checkFileSize(MAX_FILE_BYTES, MAX_FILE_BYTES)).toBeNull();
    expect(checkFileSize(0, MAX_FILE_BYTES)).toBe("The file is empty.");
    expect(checkFileSize(MAX_FILE_BYTES + 1, MAX_FILE_BYTES)).toBe("Files can be at most 256.0 KB.");
  });
  it("uses the server's limit in the text, and says files are off at 0", () => {
    expect(checkFileSize(1025, 1024)).toBe("Files can be at most 1.0 KB.");
    expect(checkFileSize(2 * 1024 * 1024, 1024 * 1024)).toBe("Files can be at most 1.0 MB.");
    expect(checkFileSize(1, 0)).toBe("This server does not accept files.");
  });
});

describe("fileTtlValues and ttlOptionsFor", () => {
  const all = [3600, 86400, 604800];
  it("offers only options up to the server's file lifetime, keeps everything for text", () => {
    expect(fileTtlValues(all, 3600)).toEqual([3600]);
    expect(fileTtlValues(all, 86400)).toEqual([3600, 86400]);
    expect(fileTtlValues(all, 7200)).toEqual([3600]);
    expect(fileTtlValues(all, 100)).toEqual([]);
    expect(ttlOptionsFor("file", all, 3600)).toEqual([3600]);
    expect(ttlOptionsFor("text", all, 3600)).toEqual(all);
  });
  it("picks the largest allowed option, or null", () => {
    expect(pickFileTtl([3600, 86400])).toBe(86400);
    expect(pickFileTtl([3600])).toBe(3600);
    expect(pickFileTtl([])).toBeNull();
  });
});

describe("formatLifetime", () => {
  it("names seconds as minutes, hours or days", () => {
    expect(formatLifetime(3600)).toBe("1 hour");
    expect(formatLifetime(7200)).toBe("2 hours");
    expect(formatLifetime(86400)).toBe("1 day");
    expect(formatLifetime(604800)).toBe("7 days");
    expect(formatLifetime(1800)).toBe("30 minutes");
    expect(formatLifetime(60)).toBe("1 minute");
    expect(formatLifetime(5400)).toBe("90 minutes");
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
    expect(uploadLabel(MAX_FILE_BYTES)).toBe("Uploading 256.0 KB…");
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
