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
  isChordShortcut,
  parseChord,
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

describe("isChordShortcut", () => {
  it("identifies chord shortcuts", () => {
    expect(isChordShortcut("Alt+M T")).toBe(true);
    expect(isChordShortcut("Ctrl+K Ctrl+C")).toBe(true);
  });

  it("identifies non-chord shortcuts", () => {
    expect(isChordShortcut("Ctrl+C")).toBe(false);
    expect(isChordShortcut("F5")).toBe(false);
    expect(isChordShortcut("Alt+Left")).toBe(false);
  });
});

describe("parseChord", () => {
  it("parses Alt+M T chord", () => {
    const chord = parseChord("Alt+M T");
    expect(chord).not.toBeNull();
    expect(chord!.prefix).toEqual({
      key: "m",
      ctrl: false,
      shift: false,
      alt: true,
      meta: false,
    });
    expect(chord!.suffix).toEqual({
      key: "t",
      ctrl: false,
      shift: false,
      alt: false,
      meta: false,
    });
  });

  it("parses Ctrl+K Ctrl+C chord", () => {
    const chord = parseChord("Ctrl+K Ctrl+C");
    expect(chord).not.toBeNull();
    expect(chord!.prefix.ctrl).toBe(true);
    expect(chord!.prefix.key).toBe("k");
    expect(chord!.suffix.ctrl).toBe(true);
    expect(chord!.suffix.key).toBe("c");
  });

  it("returns null for non-chord string", () => {
    expect(parseChord("Ctrl+C")).toBeNull();
  });
});

describe("chord formatting", () => {
  it("formats chord shortcut with space separator", () => {
    expect(formatShortcut("Alt+M T")).toBe("Alt+M T");
  });

  it("formats complex chord", () => {
    expect(formatShortcut("Ctrl+K Ctrl+C")).toBe("Ctrl+K Ctrl+C");
  });
});

describe("matchesShortcutString with chords", () => {
  it("does NOT match chord shortcuts as single-key shortcuts", () => {
    // Pressing Alt+M should NOT match "Alt+M T" as a single shortcut
    const event = createKeyboardEvent({ key: "m", altKey: true });
    expect(matchesShortcutString(event as unknown as KeyboardEvent, "Alt+M T")).toBe(false);
  });
});

// macOS-specific branches. Kept as unit tests because tauri-driver has no
// WKWebView support, so e2e-tauri/ cannot run on macOS.
describe("macOS shortcut behaviour", () => {
  interface MockKeyEventWithCode {
    key: string;
    code?: string;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    metaKey: boolean;
  }
  function macEvent(opts: {
    key: string;
    code?: string;
    ctrl?: boolean;
    shift?: boolean;
    alt?: boolean;
    meta?: boolean;
  }): MockKeyEventWithCode {
    return {
      key: opts.key,
      code: opts.code,
      ctrlKey: opts.ctrl ?? false,
      shiftKey: opts.shift ?? false,
      altKey: opts.alt ?? false,
      metaKey: opts.meta ?? false,
    };
  }

  it("Cmd+Shift+P (Mac) matches shortcut written as Ctrl+Shift+P", () => {
    // On macOS a "Ctrl+…" shortcut string should also fire when the user
    // presses Cmd+… — matchesShortcut treats metaKey || ctrlKey as ctrl.
    const event = macEvent({ key: "p", shift: true, meta: true });
    expect(matchesShortcutString(event as unknown as KeyboardEvent, "Ctrl+Shift+P")).toBe(true);
  });

  it("explicit Meta+P does NOT match Ctrl+P", () => {
    // When the shortcut string uses "Meta" explicitly, we require metaKey;
    // pressing Ctrl alone must not trigger it.
    const parsed = parseShortcut("Meta+P")!;
    const ctrlOnly = macEvent({ key: "p", ctrl: true });
    expect(matchesShortcut(ctrlOnly as unknown as KeyboardEvent, parsed)).toBe(false);
  });

  it("explicit Meta+P matches when metaKey is pressed", () => {
    const parsed = parseShortcut("Meta+P")!;
    const event = macEvent({ key: "p", meta: true });
    expect(matchesShortcut(event as unknown as KeyboardEvent, parsed)).toBe(true);
  });

  it("Alt+letter on Mac uses event.code when event.key is a special char", () => {
    // macOS produces "µ" for Alt+M instead of "m". The parser must fall
    // back to event.code ("KeyM") so the shortcut still matches.
    const event = macEvent({ key: "µ", code: "KeyM", alt: true });
    expect(matchesShortcutString(event as unknown as KeyboardEvent, "Alt+M")).toBe(true);
  });

  it("Alt+letter on Mac does NOT match a different key via event.code", () => {
    const event = macEvent({ key: "µ", code: "KeyM", alt: true });
    expect(matchesShortcutString(event as unknown as KeyboardEvent, "Alt+N")).toBe(false);
  });

  it("Alt+letter without Alt falls back to event.key (not code)", () => {
    // Sanity: the event.code path only kicks in when altKey is true.
    const event = macEvent({ key: "m", code: "KeyM" });
    expect(matchesShortcutString(event as unknown as KeyboardEvent, "M")).toBe(true);
  });
});

describe("Windows / non-US keyboard layouts (shifted symbols via event.code)", () => {
  function winEvent(opts: {
    key: string;
    code?: string;
    ctrl?: boolean;
    shift?: boolean;
    alt?: boolean;
    meta?: boolean;
  }) {
    return {
      key: opts.key,
      code: opts.code,
      ctrlKey: opts.ctrl ?? false,
      shiftKey: opts.shift ?? false,
      altKey: opts.alt ?? false,
      metaKey: opts.meta ?? false,
    };
  }

  it("Ctrl+Shift+1 matches even though event.key is the shifted symbol '!'", () => {
    // On many layouts Shift+1 yields "!"; recover "1" from event.code "Digit1".
    const event = winEvent({ key: "!", code: "Digit1", ctrl: true, shift: true });
    expect(matchesShortcutString(event as unknown as KeyboardEvent, "Ctrl+Shift+1")).toBe(true);
  });

  it("does not over-match a different digit via event.code", () => {
    const event = winEvent({ key: "!", code: "Digit1", ctrl: true, shift: true });
    expect(matchesShortcutString(event as unknown as KeyboardEvent, "Ctrl+Shift+2")).toBe(false);
  });

  it("logical event.key still matches when it agrees (no shifted symbol)", () => {
    const event = winEvent({ key: "1", code: "Digit1", ctrl: true });
    expect(matchesShortcutString(event as unknown as KeyboardEvent, "Ctrl+1")).toBe(true);
  });

  it("recording a shifted digit produces the digit, not the symbol", () => {
    const event = winEvent({ key: "!", code: "Digit1", ctrl: true, shift: true });
    expect(eventToShortcutString(event as unknown as KeyboardEvent)).toBe("Ctrl+Shift+1");
  });

  it("a pure Win/Meta binding matches when the Windows key is held", () => {
    const parsed = parseShortcut("Win+P")!;
    expect(parsed.meta).toBe(true);
    const event = winEvent({ key: "p", code: "KeyP", meta: true });
    expect(matchesShortcut(event as unknown as KeyboardEvent, parsed)).toBe(true);
  });
});

describe("exact modifier matching (Ctrl vs Meta)", () => {
  it("Ctrl+Meta+P does NOT match a Ctrl+P binding", () => {
    const parsed = parseShortcut("Ctrl+P")!;
    const event = createKeyboardEvent({ key: "p", ctrlKey: true, metaKey: true });
    expect(matchesShortcut(event as unknown as KeyboardEvent, parsed)).toBe(false);
  });

  it("Ctrl+Meta+P binding matches only when both modifiers are held", () => {
    const parsed = parseShortcut("Ctrl+Meta+P")!;
    const both = createKeyboardEvent({ key: "p", ctrlKey: true, metaKey: true });
    const ctrlOnly = createKeyboardEvent({ key: "p", ctrlKey: true });
    const metaOnly = createKeyboardEvent({ key: "p", metaKey: true });
    expect(matchesShortcut(both as unknown as KeyboardEvent, parsed)).toBe(true);
    expect(matchesShortcut(ctrlOnly as unknown as KeyboardEvent, parsed)).toBe(false);
    expect(matchesShortcut(metaOnly as unknown as KeyboardEvent, parsed)).toBe(false);
  });

  it("unmodified binding does not fire when Ctrl or Meta is held", () => {
    const parsed = parseShortcut("F2")!;
    const ctrlEvent = createKeyboardEvent({ key: "F2", ctrlKey: true });
    const metaEvent = createKeyboardEvent({ key: "F2", metaKey: true });
    expect(matchesShortcut(ctrlEvent as unknown as KeyboardEvent, parsed)).toBe(false);
    expect(matchesShortcut(metaEvent as unknown as KeyboardEvent, parsed)).toBe(false);
  });
});

describe("literal '+' key and malformed definitions", () => {
  it("parses 'Ctrl++' as Ctrl with the '+' key", () => {
    const parsed = parseShortcut("Ctrl++");
    expect(parsed).toEqual({ key: "+", ctrl: true, shift: false, alt: false, meta: false });
  });

  it("parses bare '+' as the '+' key with no modifiers", () => {
    const parsed = parseShortcut("+");
    expect(parsed).toEqual({ key: "+", ctrl: false, shift: false, alt: false, meta: false });
  });

  it("matches a Ctrl++ binding against a Ctrl '+' keypress", () => {
    const event = createKeyboardEvent({ key: "+", ctrlKey: true });
    expect(matchesShortcutString(event as unknown as KeyboardEvent, "Ctrl++")).toBe(true);
  });

  it("rejects a dangling separator like 'Ctrl+'", () => {
    expect(parseShortcut("Ctrl+")).toBeNull();
  });

  it("rejects multi-key definitions instead of keeping the last key", () => {
    expect(parseShortcut("Ctrl+A+B")).toBeNull();
    expect(parseShortcut("A+B")).toBeNull();
  });

  it("rejects garbage separator runs like 'Ctrl+++A'", () => {
    expect(parseShortcut("Ctrl+++A")).toBeNull();
  });
});
