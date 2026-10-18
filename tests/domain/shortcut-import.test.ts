import { describe, expect, it } from "vitest";
import { planShortcutImport, migrateLegacySidebarBinding } from "$lib/domain/shortcut-import";

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


it("retires the obsolete Files Sidebar default while preserving the canonical rebind", () => {
  const bindings = { "view.focusFilesSidebar": "Alt+M T", "view.toggleSidebar": "Ctrl+Alt+I", "file.openSelected": null };
  expect(migrateLegacySidebarBinding(bindings)).toEqual({ "view.toggleSidebar": "Ctrl+Alt+I", "file.openSelected": null });
  expect(bindings["view.focusFilesSidebar"]).toBe("Alt+M T");
});
it.each([null, "Ctrl+Alt+B"])("preserves a deliberate Files Sidebar binding: %s", shortcut => {
  const bindings = { "view.focusFilesSidebar": shortcut };
  expect(migrateLegacySidebarBinding(bindings)).toBe(bindings);
});
