import { describe, it, expect } from "vitest";
import { shortcutsConflict } from "$lib/domain/shortcut-conflicts";

describe("shortcut ambiguity", () => {
  it.each([
    ["Alt+M M", "alt+m m"],
    ["Alt+M M", "Alt+M"],
    ["Alt+M", "Alt+M T"],
    ["Control+Up", "Ctrl+ArrowUp"],
    ["Ctrl+K M", "Cmd+K M"],
    ["Ctrl+Shift+!", "Ctrl+Shift+1"],
    ["Alt+M Ctrl+Shift+!", "Alt+M Ctrl+Shift+1"],
  ])("reports overlapping bindings %s / %s", (left, right) => {
    expect(shortcutsConflict(left, right)).toBe(true);
    expect(shortcutsConflict(right, left)).toBe(true);
  });
  it.each([
    ["Alt+M M", "Alt+M T"],
    ["Alt+M M", "M"],
    ["Ctrl+K M", "Ctrl+Shift+K M"],
    ["Ctrl+Alt+K M", "Cmd+K M"],
    ["Ctrl+Meta+K", "Ctrl+K"],
    ["", "Ctrl+K"],
  ])("allows distinct bindings %s / %s", (left, right) => {
    expect(shortcutsConflict(left, right)).toBe(false);
  });
});
