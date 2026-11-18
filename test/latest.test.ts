import { describe, expect, it } from "vitest";
import { createLatestGuard } from "../src/web/latest";

describe("createLatestGuard", () => {
  it("accepts only the newest ticket", () => {
    const guard = createLatestGuard();
    const first = guard.next();
    expect(guard.isCurrent(first)).toBe(true);
    const second = guard.next();
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
  });
});
