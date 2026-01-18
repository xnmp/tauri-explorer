/**
 * Tests for keybinding parser.
 * Issue: tauri-explorer-npjh.4
 */

import { describe, it, expect } from "vitest";
import {
  parseShortcut,
  matchesShortcut,
  matchesShortcutString,
  formatShortcut,
  eventToShortcutString,
  type ParsedShortcut,
} from "$lib/domain/keybinding-parser";

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

describe("parseShortcut", () => {
  describe("simple shortcuts", () => {
    it("parses single key shortcut", () => {
      const result = parseShortcut("F5");
      expect(result).toEqual({
        key: "F5",
        ctrl: false,
        shift: false,
        alt: false,
        meta: false,
      });
    });

    it("parses single letter shortcut as lowercase", () => {
      const result = parseShortcut("A");
      expect(result).toEqual({
        key: "a",
        ctrl: false,
        shift: false,
        alt: false,
        meta: false,
      });
    });
  });

  describe("modifier combinations", () => {
    it("parses Ctrl+key", () => {
      const result = parseShortcut("Ctrl+C");
      expect(result).toEqual({
        key: "c",
        ctrl: true,
        shift: false,
        alt: false,
        meta: false,
      });
    });

    it("parses Ctrl+Shift+key", () => {
      const result = parseShortcut("Ctrl+Shift+P");
      expect(result).toEqual({
        key: "p",
        ctrl: true,
        shift: true,
        alt: false,
        meta: false,
      });
    });

    it("parses Alt+key", () => {
      const result = parseShortcut("Alt+Left");
      expect(result).toEqual({
        key: "ArrowLeft",
        ctrl: false,
        shift: false,
        alt: true,
        meta: false,
      });
    });
  });

  describe("arrow key aliases", () => {
    it("parses Left as ArrowLeft", () => {
      const result = parseShortcut("Left");
      expect(result?.key).toBe("ArrowLeft");
    });

    it("parses Right as ArrowRight", () => {
      const result = parseShortcut("Right");
      expect(result?.key).toBe("ArrowRight");
    });

    it("parses Up as ArrowUp", () => {
      const result = parseShortcut("Up");
      expect(result?.key).toBe("ArrowUp");
    });

    it("parses Down as ArrowDown", () => {
      const result = parseShortcut("Down");
      expect(result?.key).toBe("ArrowDown");
    });
  });

  describe("special key aliases", () => {
    it("parses Space as space character", () => {
      const result = parseShortcut("Space");
      expect(result?.key).toBe(" ");
    });

    it("parses Esc as Escape", () => {
      const result = parseShortcut("Esc");
      expect(result?.key).toBe("Escape");
    });

    it("parses Del as Delete", () => {
      const result = parseShortcut("Del");
      expect(result?.key).toBe("Delete");
    });

    it("parses Return as Enter", () => {
      const result = parseShortcut("Return");
      expect(result?.key).toBe("Enter");
    });
  });

  describe("modifier aliases", () => {
    it("parses Control as ctrl", () => {
      const result = parseShortcut("Control+C");
      expect(result?.ctrl).toBe(true);
    });

    it("parses Cmd as meta", () => {
      const result = parseShortcut("Cmd+C");
      expect(result?.meta).toBe(true);
    });

    it("parses Option as alt", () => {
      const result = parseShortcut("Option+P");
      expect(result?.alt).toBe(true);
    });
  });

  describe("invalid inputs", () => {
    it("returns null for empty string", () => {
      expect(parseShortcut("")).toBeNull();
    });

    it("returns null for whitespace only", () => {
      expect(parseShortcut("   ")).toBeNull();
    });

    it("returns null for modifier-only shortcut", () => {
      expect(parseShortcut("Ctrl+Shift")).toBeNull();
    });
  });
});

describe("matchesShortcut", () => {
  it("matches simple key", () => {
    const parsed: ParsedShortcut = {
      key: "F5",
      ctrl: false,
      shift: false,
      alt: false,
      meta: false,
    };
    const event = createKeyboardEvent({ key: "F5" });
    expect(matchesShortcut(event as unknown as KeyboardEvent, parsed)).toBe(true);
  });

  it("matches Ctrl+key", () => {
    const parsed: ParsedShortcut = {
      key: "c",
      ctrl: true,
      shift: false,
      alt: false,
      meta: false,
    };
    const event = createKeyboardEvent({ key: "c", ctrlKey: true });
    expect(matchesShortcut(event as unknown as KeyboardEvent, parsed)).toBe(true);
  });

  it("matches Ctrl+Shift+key", () => {
    const parsed: ParsedShortcut = {
      key: "p",
      ctrl: true,
      shift: true,
      alt: false,
      meta: false,
    };
    const event = createKeyboardEvent({ key: "P", ctrlKey: true, shiftKey: true });
    expect(matchesShortcut(event as unknown as KeyboardEvent, parsed)).toBe(true);
  });

  it("handles Caps Lock (uppercase letter matches lowercase)", () => {
    const parsed: ParsedShortcut = {
      key: "v",
      ctrl: true,
      shift: false,
      alt: false,
      meta: false,
    };
    // Caps Lock ON: event.key is "V" instead of "v"
    const event = createKeyboardEvent({ key: "V", ctrlKey: true });
    expect(matchesShortcut(event as unknown as KeyboardEvent, parsed)).toBe(true);
  });

  it("matches metaKey as ctrl for cross-platform", () => {
    const parsed: ParsedShortcut = {
      key: "c",
      ctrl: true,
      shift: false,
      alt: false,
      meta: false,
    };
    // Mac: Cmd is metaKey
    const event = createKeyboardEvent({ key: "c", metaKey: true });
    expect(matchesShortcut(event as unknown as KeyboardEvent, parsed)).toBe(true);
  });

  it("does not match when modifier is missing", () => {
    const parsed: ParsedShortcut = {
      key: "c",
      ctrl: true,
      shift: false,
      alt: false,
      meta: false,
    };
    const event = createKeyboardEvent({ key: "c" });
    expect(matchesShortcut(event as unknown as KeyboardEvent, parsed)).toBe(false);
  });

  it("does not match when extra modifier is pressed", () => {
    const parsed: ParsedShortcut = {
      key: "c",
      ctrl: true,
      shift: false,
      alt: false,
      meta: false,
    };
    const event = createKeyboardEvent({ key: "c", ctrlKey: true, shiftKey: true });
    expect(matchesShortcut(event as unknown as KeyboardEvent, parsed)).toBe(false);
  });
});

describe("matchesShortcutString", () => {
  it("matches Ctrl+C", () => {
    const event = createKeyboardEvent({ key: "c", ctrlKey: true });
    expect(matchesShortcutString(event as unknown as KeyboardEvent, "Ctrl+C")).toBe(true);
  });

  it("matches Ctrl+Shift+P", () => {
    const event = createKeyboardEvent({ key: "P", ctrlKey: true, shiftKey: true });
    expect(matchesShortcutString(event as unknown as KeyboardEvent, "Ctrl+Shift+P")).toBe(true);
  });

  it("matches Alt+Left", () => {
    const event = createKeyboardEvent({ key: "ArrowLeft", altKey: true });
    expect(matchesShortcutString(event as unknown as KeyboardEvent, "Alt+Left")).toBe(true);
  });

  it("matches F5", () => {
    const event = createKeyboardEvent({ key: "F5" });
    expect(matchesShortcutString(event as unknown as KeyboardEvent, "F5")).toBe(true);
  });

  it("returns false for invalid shortcut string", () => {
    const event = createKeyboardEvent({ key: "c", ctrlKey: true });
    expect(matchesShortcutString(event as unknown as KeyboardEvent, "")).toBe(false);
  });
});

describe("formatShortcut", () => {
  it("formats simple key", () => {
    expect(formatShortcut("F5")).toBe("F5");
  });

  it("formats Ctrl+key with uppercase letter", () => {
    expect(formatShortcut("Ctrl+C")).toBe("Ctrl+C");
  });

  it("formats Ctrl+Shift+key", () => {
    expect(formatShortcut("Ctrl+Shift+P")).toBe("Ctrl+Shift+P");
  });

  it("formats arrow keys with symbols", () => {
    expect(formatShortcut("Alt+Left")).toBe("Alt+←");
  });

  it("formats Space key", () => {
    expect(formatShortcut("Space")).toBe("Space");
  });

  it("formats Escape as Esc", () => {
    expect(formatShortcut("Escape")).toBe("Esc");
  });

  it("formats Delete as Del", () => {
    expect(formatShortcut("Delete")).toBe("Del");
  });
});

describe("eventToShortcutString", () => {
  it("converts Ctrl+C event to string", () => {
    const event = createKeyboardEvent({ key: "c", ctrlKey: true });
    expect(eventToShortcutString(event as unknown as KeyboardEvent)).toBe("Ctrl+C");
  });

  it("converts Ctrl+Shift+P event to string", () => {
    const event = createKeyboardEvent({ key: "P", ctrlKey: true, shiftKey: true });
    expect(eventToShortcutString(event as unknown as KeyboardEvent)).toBe("Ctrl+Shift+P");
  });

  it("converts Alt+ArrowLeft to Alt+Left", () => {
    const event = createKeyboardEvent({ key: "ArrowLeft", altKey: true });
    expect(eventToShortcutString(event as unknown as KeyboardEvent)).toBe("Alt+Left");
  });

  it("converts F5 to F5", () => {
    const event = createKeyboardEvent({ key: "F5" });
    expect(eventToShortcutString(event as unknown as KeyboardEvent)).toBe("F5");
  });

  it("returns null for modifier-only key", () => {
    const event = createKeyboardEvent({ key: "Control" });
    expect(eventToShortcutString(event as unknown as KeyboardEvent)).toBeNull();
  });

  it("returns null for Shift-only key", () => {
    const event = createKeyboardEvent({ key: "Shift" });
    expect(eventToShortcutString(event as unknown as KeyboardEvent)).toBeNull();
  });

  it("handles space key", () => {
    const event = createKeyboardEvent({ key: " ", ctrlKey: true });
    expect(eventToShortcutString(event as unknown as KeyboardEvent)).toBe("Ctrl+Space");
  });
});

describe("real-world shortcuts", () => {
  const shortcuts = [
    { string: "Ctrl+C", key: "c", ctrl: true },
    { string: "Ctrl+X", key: "x", ctrl: true },
    { string: "Ctrl+V", key: "v", ctrl: true },
    { string: "Ctrl+Z", key: "z", ctrl: true },
    { string: "Ctrl+A", key: "a", ctrl: true },
    { string: "Ctrl+P", key: "p", ctrl: true },
    { string: "Ctrl+Shift+P", key: "P", ctrl: true, shift: true },
    { string: "Ctrl+Shift+F", key: "F", ctrl: true, shift: true },
    { string: "Ctrl+T", key: "t", ctrl: true },
    { string: "Ctrl+W", key: "w", ctrl: true },
    { string: "Ctrl+H", key: "h", ctrl: true },
    { string: "Alt+Left", key: "ArrowLeft", alt: true },
    { string: "Alt+Right", key: "ArrowRight", alt: true },
    { string: "Alt+Up", key: "ArrowUp", alt: true },
    { string: "F2", key: "F2" },
    { string: "F5", key: "F5" },
    { string: "F6", key: "F6" },
    { string: "Delete", key: "Delete" },
    { string: "Enter", key: "Enter" },
    { string: "Escape", key: "Escape" },
  ];

  for (const shortcut of shortcuts) {
    it(`matches ${shortcut.string}`, () => {
      const event = createKeyboardEvent({
        key: shortcut.key,
        ctrlKey: shortcut.ctrl,
        shiftKey: shortcut.shift,
        altKey: shortcut.alt,
      });
      expect(matchesShortcutString(event as unknown as KeyboardEvent, shortcut.string)).toBe(true);
    });
  }
});
