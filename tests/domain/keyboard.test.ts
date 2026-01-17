/**
 * Tests for keyboard shortcut utilities.
 * Issue: P0 bug fix - Ctrl+V and Ctrl+Z not working when Caps Lock is on.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeKeyForShortcut,
  matchesShortcutKey,
  SHORTCUT_KEYS,
  SPECIAL_KEYS,
} from "$lib/domain/keyboard";

describe("normalizeKeyForShortcut", () => {
  describe("letter keys", () => {
    it("normalizes lowercase letters to lowercase", () => {
      expect(normalizeKeyForShortcut("v")).toBe("v");
      expect(normalizeKeyForShortcut("c")).toBe("c");
      expect(normalizeKeyForShortcut("z")).toBe("z");
    });

    it("normalizes uppercase letters to lowercase (Caps Lock scenario)", () => {
      expect(normalizeKeyForShortcut("V")).toBe("v");
      expect(normalizeKeyForShortcut("C")).toBe("c");
      expect(normalizeKeyForShortcut("Z")).toBe("z");
    });

    it("handles all alphabet letters", () => {
      const lowercase = "abcdefghijklmnopqrstuvwxyz";
      const uppercase = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

      for (let i = 0; i < 26; i++) {
        expect(normalizeKeyForShortcut(lowercase[i])).toBe(lowercase[i]);
        expect(normalizeKeyForShortcut(uppercase[i])).toBe(lowercase[i]);
      }
    });
  });

  describe("special keys", () => {
    it("preserves Delete key casing", () => {
      expect(normalizeKeyForShortcut("Delete")).toBe("Delete");
    });

    it("preserves function keys casing", () => {
      expect(normalizeKeyForShortcut("F1")).toBe("F1");
      expect(normalizeKeyForShortcut("F2")).toBe("F2");
      expect(normalizeKeyForShortcut("F12")).toBe("F12");
    });

    it("preserves arrow keys casing", () => {
      expect(normalizeKeyForShortcut("ArrowUp")).toBe("ArrowUp");
      expect(normalizeKeyForShortcut("ArrowDown")).toBe("ArrowDown");
      expect(normalizeKeyForShortcut("ArrowLeft")).toBe("ArrowLeft");
      expect(normalizeKeyForShortcut("ArrowRight")).toBe("ArrowRight");
    });

    it("preserves other special keys", () => {
      expect(normalizeKeyForShortcut("Enter")).toBe("Enter");
      expect(normalizeKeyForShortcut("Escape")).toBe("Escape");
      expect(normalizeKeyForShortcut("Tab")).toBe("Tab");
      expect(normalizeKeyForShortcut("Backspace")).toBe("Backspace");
    });
  });

  describe("single character non-letters", () => {
    it("normalizes number keys (treated as single characters)", () => {
      expect(normalizeKeyForShortcut("1")).toBe("1");
      expect(normalizeKeyForShortcut("9")).toBe("9");
    });

    it("normalizes symbol keys", () => {
      expect(normalizeKeyForShortcut(" ")).toBe(" ");
      expect(normalizeKeyForShortcut("-")).toBe("-");
      expect(normalizeKeyForShortcut("/")).toBe("/");
    });
  });
});

describe("matchesShortcutKey", () => {
  it("matches lowercase key to lowercase target", () => {
    expect(matchesShortcutKey("v", "v")).toBe(true);
    expect(matchesShortcutKey("c", "c")).toBe(true);
  });

  it("matches uppercase key (Caps Lock) to lowercase target", () => {
    expect(matchesShortcutKey("V", "v")).toBe(true);
    expect(matchesShortcutKey("C", "c")).toBe(true);
    expect(matchesShortcutKey("Z", "z")).toBe(true);
  });

  it("does not match different keys", () => {
    expect(matchesShortcutKey("v", "c")).toBe(false);
    expect(matchesShortcutKey("V", "c")).toBe(false);
  });

  it("matches special keys exactly", () => {
    expect(matchesShortcutKey("Delete", "Delete")).toBe(true);
    expect(matchesShortcutKey("F2", "F2")).toBe(true);
  });

  it("does not match mismatched special keys", () => {
    expect(matchesShortcutKey("Delete", "delete")).toBe(false);
    expect(matchesShortcutKey("F2", "f2")).toBe(false);
  });
});

describe("SHORTCUT_KEYS constants", () => {
  it("defines common shortcuts as lowercase", () => {
    expect(SHORTCUT_KEYS.COPY).toBe("c");
    expect(SHORTCUT_KEYS.CUT).toBe("x");
    expect(SHORTCUT_KEYS.PASTE).toBe("v");
    expect(SHORTCUT_KEYS.UNDO).toBe("z");
    expect(SHORTCUT_KEYS.SELECT_ALL).toBe("a");
  });
});

describe("SPECIAL_KEYS constants", () => {
  it("defines special keys with correct casing", () => {
    expect(SPECIAL_KEYS.DELETE).toBe("Delete");
    expect(SPECIAL_KEYS.F2).toBe("F2");
    expect(SPECIAL_KEYS.ARROW_UP).toBe("ArrowUp");
    expect(SPECIAL_KEYS.ESCAPE).toBe("Escape");
  });
});

describe("real-world scenarios", () => {
  it("handles Ctrl+V with Caps Lock OFF", () => {
    // Simulates: Caps Lock OFF, user presses Ctrl+V
    const eventKey = "v";
    const normalized = normalizeKeyForShortcut(eventKey);
    expect(normalized).toBe("v");
    expect(matchesShortcutKey(eventKey, SHORTCUT_KEYS.PASTE)).toBe(true);
  });

  it("handles Ctrl+V with Caps Lock ON", () => {
    // Simulates: Caps Lock ON, user presses Ctrl+V
    const eventKey = "V";
    const normalized = normalizeKeyForShortcut(eventKey);
    expect(normalized).toBe("v");
    expect(matchesShortcutKey(eventKey, SHORTCUT_KEYS.PASTE)).toBe(true);
  });

  it("handles Ctrl+Z with Caps Lock ON", () => {
    // Simulates: Caps Lock ON, user presses Ctrl+Z
    const eventKey = "Z";
    const normalized = normalizeKeyForShortcut(eventKey);
    expect(normalized).toBe("z");
    expect(matchesShortcutKey(eventKey, SHORTCUT_KEYS.UNDO)).toBe(true);
  });

  it("handles Delete key regardless of Caps Lock", () => {
    // Delete key is always "Delete" regardless of Caps Lock
    const eventKey = "Delete";
    expect(matchesShortcutKey(eventKey, SPECIAL_KEYS.DELETE)).toBe(true);
  });

  it("handles F2 key regardless of Caps Lock", () => {
    // F2 key is always "F2" regardless of Caps Lock
    const eventKey = "F2";
    expect(matchesShortcutKey(eventKey, SPECIAL_KEYS.F2)).toBe(true);
  });
});
