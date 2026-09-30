import { describe, it, expect } from "vitest";
import { createOrderedRegistry } from "$lib/state/ordered-registry";

describe("ordered contribution registry", () => {
  it("presents contributions by order, then by registration", () => {
    const registry = createOrderedRegistry<string>();
    registry.register("late-unordered", "unordered");
    registry.register("second-b", "b", 2);
    registry.register("first", "a", 1);
    registry.register("second-c", "c", 2);

    expect(registry.values()).toEqual(["a", "b", "c", "unordered"]);
  });

  it("removes only the registration its disposer owns", () => {
    const registry = createOrderedRegistry<string>();
    const disposeFirst = registry.register("shared", "first", 0);
    expect(disposeFirst()).toBe(true);
    registry.register("shared", "replacement", 0);

    // A stale disposer (e.g. from a retired activation) must not remove the
    // contribution that took its id.
    expect(disposeFirst()).toBe(false);
    expect(registry.values()).toEqual(["replacement"]);
  });

  it("rejects a duplicate id while the first registration is live", () => {
    const registry = createOrderedRegistry<string>();
    registry.register("dup", "first");

    expect(() => registry.register("dup", "second")).toThrow("Already registered: dup");
    expect(registry.values()).toEqual(["first"]);
  });

  it("is empty after clear, and accepts the same ids again", () => {
    const registry = createOrderedRegistry<string>();
    registry.register("x", "x", 0);
    registry.clear();
    expect(registry.values()).toEqual([]);
    registry.register("x", "again", 0);
    expect(registry.values()).toEqual(["again"]);
  });
});
