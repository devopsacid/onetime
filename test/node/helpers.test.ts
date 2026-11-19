import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tempDir, trackChild } from "./helpers";

// The two tests run in order: the second looks at what the first left behind for the hooks to clean.
describe("test helper hygiene", () => {
  let child: ChildProcess;
  let dir: string;
  it("leaves a tracked child running and a temp dir behind", () => {
    child = trackChild(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]));
    dir = tempDir().path;
    expect(child.exitCode).toBeNull();
    expect(existsSync(dir)).toBe(true);
  });
  it("finds the child killed and the directory removed after that test", () => {
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });
});
