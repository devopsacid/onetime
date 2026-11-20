import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("CLI entry point", () => {
  it("never sets the test-only hooks (pbkdf2Iterations, writeFormat)", () => {
    const main = read("cli/main.ts");
    expect(main).not.toMatch(/pbkdf2Iterations/);
    expect(main).not.toMatch(/writeFormat/);
  });

  it("provides readFile and reads at most max + 1 bytes of it", () => {
    const main = read("cli/main.ts");
    expect(main).toMatch(/readFile/);
    expect(main).toMatch(/max \+ 1/);
  });

  it("is version 0.2.0 (it reads format 2 links)", () => {
    expect(JSON.parse(read("package.json")).version).toBe("0.2.0");
  });
});
