import { describe, it, expect } from "vitest";
import { unresolvedIndicator } from "$lib/domain/ai-operations";

describe("unresolvedIndicator", () => {
  it("is hidden with nothing unresolved", () => expect(unresolvedIndicator(0)).toBeNull());
  it("shows count and accessible name for one", () =>
    expect(unresolvedIndicator(1)).toEqual({ text: "1 unresolved", label: "Unresolved AI operations: 1" }));
  it("shows count for many", () =>
    expect(unresolvedIndicator(42)).toEqual({ text: "42 unresolved", label: "Unresolved AI operations: 42" }));
  it.each([-1, 1.5, NaN, Infinity, "3", null, undefined, {}, Number.MAX_VALUE])("is hidden for malformed %s", (v) =>
    expect(unresolvedIndicator(v)).toBeNull());
});
