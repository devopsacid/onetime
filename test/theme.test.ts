import { describe, expect, it } from "vitest";
import { otherTheme, parseStoredTheme, resolveTheme, toggleLabel } from "../src/web/theme";

describe("parseStoredTheme", () => {
  it("accepts only light and dark", () => {
    expect(parseStoredTheme("light")).toBe("light");
    expect(parseStoredTheme("dark")).toBe("dark");
    for (const junk of [null, undefined, "", "Dark", "system", "black", " dark"]) {
      expect(parseStoredTheme(junk)).toBeNull();
    }
  });
});

describe("resolveTheme", () => {
  it("follows the system setting when nothing valid is stored", () => {
    expect(resolveTheme(null, true)).toBe("dark");
    expect(resolveTheme(null, false)).toBe("light");
    expect(resolveTheme("garbage", true)).toBe("dark");
  });

  it("lets an explicit choice override the system setting", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("toggle", () => {
  it("names the theme the button switches to", () => {
    expect(otherTheme("light")).toBe("dark");
    expect(otherTheme("dark")).toBe("light");
    expect(toggleLabel("light")).toBe("Switch to dark theme");
    expect(toggleLabel("dark")).toBe("Switch to light theme");
  });
});
