/**
 * Tests for keybindings state management.
 * Issue: tauri-explorer-npjh.4
 *
 * Tests keybinding storage, conflict detection, and matching logic.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { keybindingsStore } from "$lib/state/keybindings.svelte";

/** Mock KeyboardEvent for Node test environment */
interface MockKeyboardEvent {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** Helper to create a mock KeyboardEvent */
function createKeyboardEvent(options: {
  key: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}): MockKeyboardEvent {
  return {
    key: options.key,
    ctrlKey: options.ctrlKey ?? false,
    shiftKey: options.shiftKey ?? false,
    altKey: options.altKey ?? false,
    metaKey: options.metaKey ?? false,
  };
}

describe("keybindingsStore", () => {
  // Reset the store before each test
  beforeEach(() => {
    // Clear localStorage mock
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    // Clear all data for test isolation
    keybindingsStore._clearForTesting();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("registerDefaults", () => {
    it("registers default shortcuts", () => {
      keybindingsStore.registerDefaults({
        "test.copy": "Ctrl+C",
        "test.paste": "Ctrl+V",
      });

      expect(keybindingsStore.getShortcut("test.copy")).toBe("Ctrl+C");
      expect(keybindingsStore.getShortcut("test.paste")).toBe("Ctrl+V");
    });

    it("returns undefined for unregistered command", () => {
      expect(keybindingsStore.getShortcut("nonexistent")).toBeUndefined();
    });
  });

  describe("getShortcut", () => {
    beforeEach(() => {
      keybindingsStore.registerDefaults({
        "edit.copy": "Ctrl+C",
        "edit.paste": "Ctrl+V",
      });
    });

    it("returns default shortcut when no user override", () => {
      expect(keybindingsStore.getShortcut("edit.copy")).toBe("Ctrl+C");
    });

    it("returns user override when set", () => {
      keybindingsStore.setShortcut("edit.copy", "Ctrl+Shift+C");
      expect(keybindingsStore.getShortcut("edit.copy")).toBe("Ctrl+Shift+C");
    });

    it("returns undefined when command is unbound", () => {
      keybindingsStore.setShortcut("edit.copy", null);
      expect(keybindingsStore.getShortcut("edit.copy")).toBeUndefined();
    });
  });

  describe("setShortcut", () => {
    beforeEach(() => {
      keybindingsStore.registerDefaults({
        "edit.copy": "Ctrl+C",
      });
    });

    it("overrides default with custom shortcut", () => {
      keybindingsStore.setShortcut("edit.copy", "Alt+C");
      expect(keybindingsStore.getShortcut("edit.copy")).toBe("Alt+C");
    });

    it("can unbind a shortcut by setting null", () => {
      keybindingsStore.setShortcut("edit.copy", null);
      expect(keybindingsStore.getShortcut("edit.copy")).toBeUndefined();
    });
  });

  describe("resetToDefault", () => {
    beforeEach(() => {
      keybindingsStore.registerDefaults({
        "edit.copy": "Ctrl+C",
        "edit.paste": "Ctrl+V",
      });
    });

    it("resets a custom shortcut to default", () => {
      keybindingsStore.setShortcut("edit.copy", "Alt+C");
      expect(keybindingsStore.getShortcut("edit.copy")).toBe("Alt+C");

      keybindingsStore.resetToDefault("edit.copy");
      expect(keybindingsStore.getShortcut("edit.copy")).toBe("Ctrl+C");
    });

    it("does not affect other shortcuts", () => {
      keybindingsStore.setShortcut("edit.copy", "Alt+C");
      keybindingsStore.setShortcut("edit.paste", "Alt+V");

      keybindingsStore.resetToDefault("edit.copy");

      expect(keybindingsStore.getShortcut("edit.copy")).toBe("Ctrl+C");
      expect(keybindingsStore.getShortcut("edit.paste")).toBe("Alt+V");
    });
  });

  describe("resetAllToDefaults", () => {
    beforeEach(() => {
      keybindingsStore.registerDefaults({
        "edit.copy": "Ctrl+C",
        "edit.paste": "Ctrl+V",
      });
    });

    it("resets all custom shortcuts to defaults", () => {
      keybindingsStore.setShortcut("edit.copy", "Alt+C");
      keybindingsStore.setShortcut("edit.paste", "Alt+V");

      keybindingsStore.resetAllToDefaults();

      expect(keybindingsStore.getShortcut("edit.copy")).toBe("Ctrl+C");
      expect(keybindingsStore.getShortcut("edit.paste")).toBe("Ctrl+V");
    });
  });

  describe("hasCustomShortcut", () => {
    beforeEach(() => {
      keybindingsStore.registerDefaults({
        "edit.copy": "Ctrl+C",
      });
    });

    it("returns false when no custom shortcut", () => {
      expect(keybindingsStore.hasCustomShortcut("edit.copy")).toBe(false);
    });

    it("returns true when custom shortcut is set", () => {
      keybindingsStore.setShortcut("edit.copy", "Alt+C");
      expect(keybindingsStore.hasCustomShortcut("edit.copy")).toBe(true);
    });

    it("returns true when shortcut is unbound", () => {
      keybindingsStore.setShortcut("edit.copy", null);
      expect(keybindingsStore.hasCustomShortcut("edit.copy")).toBe(true);
    });
  });

  describe("findMatchingCommand", () => {
    beforeEach(() => {
      keybindingsStore.registerDefaults({
        "edit.copy": "Ctrl+C",
        "edit.paste": "Ctrl+V",
        "navigation.refresh": "F5",
      });
    });

    it("finds command matching Ctrl+C", () => {
      const event = createKeyboardEvent({ key: "c", ctrlKey: true });
      expect(keybindingsStore.findMatchingCommand(event as unknown as KeyboardEvent)).toBe("edit.copy");
    });

    it("finds command matching F5", () => {
      const event = createKeyboardEvent({ key: "F5" });
      expect(keybindingsStore.findMatchingCommand(event as unknown as KeyboardEvent)).toBe("navigation.refresh");
    });

    it("returns undefined for unbound event", () => {
      const event = createKeyboardEvent({ key: "z", ctrlKey: true });
      expect(keybindingsStore.findMatchingCommand(event as unknown as KeyboardEvent)).toBeUndefined();
    });

    it("uses custom shortcut when set", () => {
      keybindingsStore.setShortcut("edit.copy", "Alt+C");

      // Old shortcut should not match
      const ctrlC = createKeyboardEvent({ key: "c", ctrlKey: true });
      expect(keybindingsStore.findMatchingCommand(ctrlC as unknown as KeyboardEvent)).toBeUndefined();

      // New shortcut should match
      const altC = createKeyboardEvent({ key: "c", altKey: true });
      expect(keybindingsStore.findMatchingCommand(altC as unknown as KeyboardEvent)).toBe("edit.copy");
    });

    it("handles Caps Lock (uppercase key)", () => {
      const event = createKeyboardEvent({ key: "C", ctrlKey: true });
      expect(keybindingsStore.findMatchingCommand(event as unknown as KeyboardEvent)).toBe("edit.copy");
    });
  });

  describe("findConflicts", () => {
    beforeEach(() => {
      keybindingsStore.registerDefaults({
        "edit.copy": "Ctrl+C",
        "edit.paste": "Ctrl+V",
        "edit.cut": "Ctrl+X",
      });
    });

    it("returns empty array when no conflicts", () => {
      const conflicts = keybindingsStore.findConflicts("Ctrl+Z");
      expect(conflicts).toEqual([]);
    });

    it("finds conflicting command", () => {
      const conflicts = keybindingsStore.findConflicts("Ctrl+C");
      expect(conflicts).toEqual(["edit.copy"]);
    });

    it("excludes specified command from conflicts", () => {
      const conflicts = keybindingsStore.findConflicts("Ctrl+C", "edit.copy");
      expect(conflicts).toEqual([]);
    });

    it("is case-insensitive", () => {
      const conflicts = keybindingsStore.findConflicts("ctrl+c");
      expect(conflicts).toEqual(["edit.copy"]);
    });
  });

  describe("getAllBindings", () => {
    beforeEach(() => {
      keybindingsStore.registerDefaults({
        "edit.copy": "Ctrl+C",
        "edit.paste": "Ctrl+V",
      });
    });

    it("returns all registered bindings", () => {
      const bindings = keybindingsStore.getAllBindings();
      expect(bindings).toHaveLength(2);
    });

    it("includes default and user shortcuts", () => {
      keybindingsStore.setShortcut("edit.copy", "Alt+C");

      const bindings = keybindingsStore.getAllBindings();
      const copyBinding = bindings.find((b) => b.commandId === "edit.copy");

      expect(copyBinding).toBeDefined();
      expect(copyBinding?.defaultShortcut).toBe("Ctrl+C");
      expect(copyBinding?.userShortcut).toBe("Alt+C");
    });

    it("includes unbound shortcuts as null", () => {
      keybindingsStore.setShortcut("edit.copy", null);

      const bindings = keybindingsStore.getAllBindings();
      const copyBinding = bindings.find((b) => b.commandId === "edit.copy");

      expect(copyBinding?.userShortcut).toBeNull();
    });
  });

  describe("getDisplayShortcut", () => {
    beforeEach(() => {
      keybindingsStore.registerDefaults({
        "navigation.back": "Alt+Left",
        "edit.copy": "Ctrl+C",
      });
    });

    it("formats shortcuts for display", () => {
      expect(keybindingsStore.getDisplayShortcut("navigation.back")).toBe("Alt+←");
      expect(keybindingsStore.getDisplayShortcut("edit.copy")).toBe("Ctrl+C");
    });

    it("returns undefined for unbound command", () => {
      keybindingsStore.setShortcut("edit.copy", null);
      expect(keybindingsStore.getDisplayShortcut("edit.copy")).toBeUndefined();
    });

    it("returns undefined for unknown command", () => {
      expect(keybindingsStore.getDisplayShortcut("unknown")).toBeUndefined();
    });
  });
});
