import { afterEach, describe, expect, it } from "vitest";
import { keybindingsStore } from "$lib/state/keybindings.svelte";
import { shortcutSuffix } from "$lib/state/command-shortcut-label";

afterEach(() => keybindingsStore.resetToDefault("test.cmd"));

describe("shortcutSuffix", () => {
  it("follows a persisted override", () => {
    keybindingsStore.setShortcut("test.cmd", "Ctrl+Shift+K");
    expect(shortcutSuffix("test.cmd")).toBe(" (Ctrl+Shift+K)");
    keybindingsStore.setShortcut("test.cmd", "Alt+Q");
    expect(shortcutSuffix("test.cmd")).toBe(" (Alt+Q)");
  });

  it("is empty for an unbound command", () => {
    keybindingsStore.setShortcut("test.cmd", null);
    expect(shortcutSuffix("test.cmd")).toBe("");
  });

  it("is empty for an unknown command", () => {
    expect(shortcutSuffix("no.such.command")).toBe("");
  });
});
