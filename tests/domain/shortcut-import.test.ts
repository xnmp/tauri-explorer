import { describe, expect, it } from "vitest";
import { planShortcutImport } from "$lib/domain/shortcut-import";

describe("shortcut import final-state validation", () => {
  it.each([
    [{ a: "Alt+M M", b: "Ctrl+A" }, { a: "Ctrl+A", b: "Alt+M M" }],
    [{ a: "Ctrl+B", b: "Ctrl+C", c: "Ctrl+A" }, { a: "Ctrl+A", b: "Ctrl+B", c: "Ctrl+C" }],
  ])("allows conflict-free swaps and cycles", (candidates, current) => {
    expect(planShortcutImport(current, candidates)).toEqual({ accepted: candidates, conflicts: [] });
  });
  it("applies explicit unbinding regardless of object order", () => {
    expect(planShortcutImport({ a: "Ctrl+A", b: "Alt+M M" }, { a: "Alt+M M", b: null })).toEqual({ accepted: { a: "Alt+M M", b: null }, conflicts: [] });
  });
  it("rejects imported prefix ambiguity against unchanged commands", () => {
    expect(planShortcutImport({ a: "Ctrl+A", b: "Alt+M M" }, { a: "Alt+M" })).toEqual({ accepted: {}, conflicts: ["a"] });
  });
  it("rejects both imported duplicate bindings without silently displacing either", () => {
    expect(planShortcutImport({ a: "Ctrl+A", b: "Ctrl+B" }, { a: "Alt+M M", b: "Alt+M M" })).toEqual({ accepted: {}, conflicts: ["a", "b"] });
  });
  it("rechecks restored defaults after rejecting another candidate", () => {
    expect(planShortcutImport({ a: "Ctrl+A", b: "Ctrl+B", c: "Ctrl+C" }, { a: "Ctrl+B", b: "Ctrl+C" })).toEqual({ accepted: {}, conflicts: ["b", "a"] });
  });
});
