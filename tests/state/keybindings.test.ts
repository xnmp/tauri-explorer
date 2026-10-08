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

  it("allows actual modifier keydown before a modified chord suffix", () => {
    keybindingsStore.registerDefault("test", "Alt+M Ctrl+C");
    const press = (key: string, extra = {}) => keybindingsStore.findMatchingCommand({ ...createKeyboardEvent({ key }), ...extra } as KeyboardEvent);
    expect(press("m", { altKey: true })).toBe("chord:waiting");
    expect(press("Control", { ctrlKey: true })).toBeUndefined();
    expect(press("c", { ctrlKey: true })).toBe("test");
  });

  it.each(["Alt+M Alt+M", "Alt+M M"])("holding the prefix never completes or cancels %s", (shortcut) => {
    keybindingsStore.registerDefault("test", shortcut);
    const event = { ...createKeyboardEvent({ key: "m", altKey: true }), repeat: false } as KeyboardEvent;
    expect(keybindingsStore.findMatchingCommand(event)).toBe("chord:waiting");
    expect(keybindingsStore.findMatchingCommand({ ...event, repeat: true } as KeyboardEvent)).toBeUndefined();
    expect(keybindingsStore.isChordActive).toBe(true);
    expect(keybindingsStore.findMatchingCommand({ ...event, altKey: shortcut.endsWith("Alt+M") } as KeyboardEvent)).toBe("test");
  });

  describe("command disposal during a chord", () => {
    const press = (key: string, altKey = false) => keybindingsStore.findMatchingCommand(
      createKeyboardEvent({ key, altKey }) as KeyboardEvent,
    );

    it("preserves an unrelated command's pending chord", () => {
      keybindingsStore.registerDefault("chord", "Alt+M T");
      keybindingsStore.registerDefault("image-edit", "Ctrl+E");
      expect(press("m", true)).toBe("chord:waiting");
      keybindingsStore.unregisterDefault("image-edit");
      expect(press("t")).toBe("chord");
    });

    it("retires a chord when its last candidate is removed", () => {
      keybindingsStore.registerDefault("chord", "Alt+M T");
      expect(press("m", true)).toBe("chord:waiting");
      keybindingsStore.unregisterDefault("chord");
      expect(keybindingsStore.isChordActive).toBe(false);
      expect(press("t")).toBeUndefined();
    });

    it("preserves other candidates sharing the same prefix", () => {
      keybindingsStore.registerDefault("first", "Alt+M T");
      keybindingsStore.registerDefault("second", "Alt+M G");
      expect(press("m", true)).toBe("chord:waiting");
      keybindingsStore.unregisterDefault("first");
      expect(press("g")).toBe("second");
    });
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
    it("persists explicit unbinding so a conflict cannot return after restart", () => {
      keybindingsStore.setShortcut("edit.copy", null);
      const writes = vi.mocked(localStorage.setItem).mock.calls;
      const saved = JSON.parse(writes.at(-1)![1]);
      expect(saved).toEqual({ "edit.copy": null });
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
    it("custom shared-prefix chords execute one suffix once and expire at the deadline", () => {
      vi.useFakeTimers();
      try {
        keybindingsStore.registerDefaults({ "one": "Ctrl+1", "two": "Ctrl+2" });
        keybindingsStore.setShortcut("one", "Alt+M M");
        keybindingsStore.setShortcut("two", "Alt+M T");
        const prefix = createKeyboardEvent({ key: "m", altKey: true }) as KeyboardEvent;
        const m = createKeyboardEvent({ key: "m" }) as KeyboardEvent;
        const t = createKeyboardEvent({ key: "t" }) as KeyboardEvent;
        expect(keybindingsStore.findMatchingCommand(prefix)).toBe("chord:waiting");
        vi.advanceTimersByTime(1499);
        expect(keybindingsStore.findMatchingCommand(t)).toBe("two");
        expect(keybindingsStore.findMatchingCommand(t)).toBeUndefined();
        keybindingsStore.findMatchingCommand(prefix);
        vi.advanceTimersByTime(1500);
        expect(keybindingsStore.findMatchingCommand(m)).toBeUndefined();
        keybindingsStore.findMatchingCommand(prefix);
        expect(keybindingsStore.findMatchingCommand(createKeyboardEvent({ key: "Escape" }) as KeyboardEvent)).toBeUndefined();
        expect(keybindingsStore.findMatchingCommand(m)).toBeUndefined();
        keybindingsStore.findMatchingCommand(prefix);
        expect(keybindingsStore.findMatchingCommand(createKeyboardEvent({ key: "x" }) as KeyboardEvent)).toBeUndefined();
        expect(keybindingsStore.findMatchingCommand(m)).toBeUndefined();
      } finally { vi.useRealTimers(); }
    });
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

    it("respects isAvailable predicate when provided", () => {
      keybindingsStore.registerDefaults({
        "command.available": "Ctrl+A",
        "command.unavailable": "Ctrl+B",
      });

      const eventA = createKeyboardEvent({ key: "a", ctrlKey: true });
      const eventB = createKeyboardEvent({ key: "b", ctrlKey: true });

      // With predicate that makes only command.available available
      const isAvailable = (commandId: string) => commandId === "command.available";

      expect(keybindingsStore.findMatchingCommand(eventA as unknown as KeyboardEvent, isAvailable)).toBe("command.available");
      expect(keybindingsStore.findMatchingCommand(eventB as unknown as KeyboardEvent, isAvailable)).toBeUndefined();
    });

    it("finds first available command when isAvailable predicate provided", () => {
      keybindingsStore.registerDefaults({
        "command.first": "Ctrl+C",
        "command.second": "Ctrl+C", // Intentional duplicate for testing
      });

      const event = createKeyboardEvent({ key: "c", ctrlKey: true });

      // Make only second command available
      const isAvailable = (commandId: string) => commandId === "command.second";

      expect(keybindingsStore.findMatchingCommand(event as unknown as KeyboardEvent, isAvailable)).toBe("command.second");
    });

    it("works without isAvailable predicate (backward compatibility)", () => {
      const event = createKeyboardEvent({ key: "c", ctrlKey: true });
      expect(keybindingsStore.findMatchingCommand(event as unknown as KeyboardEvent)).toBe("edit.copy");
    });
  });

  describe("findConflicts", () => {
    it("reports every ambiguous single-key prefix but allows distinct chord suffixes", () => {
      keybindingsStore.registerDefaults({ "one": "Alt+M M", "two": "Alt+M T" });
      expect(keybindingsStore.findConflicts("Alt+M")).toEqual(["one", "two"]);
      expect(keybindingsStore.findConflicts("Alt+M B")).toEqual([]);
      expect(keybindingsStore.findConflicts("Alt+M M")).toEqual(["one"]);
    });
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
