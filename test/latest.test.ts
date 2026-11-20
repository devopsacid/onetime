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

describe("createLatestGuard.current", () => {
  it("returns the ticket in force without issuing a new one", () => {
    const guard = createLatestGuard();
    const first = guard.next();
    expect(guard.current()).toBe(first);
    expect(guard.current()).toBe(first);
    expect(guard.isCurrent(guard.current())).toBe(true);
    guard.next();
    expect(guard.isCurrent(first)).toBe(false);
  });
});
