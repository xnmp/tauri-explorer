/**
 * Keybinding parser for customizable hotkeys.
 * Issue: tauri-explorer-npjh.4
 *
 * Parses shortcut strings (e.g., "Ctrl+Shift+P") and matches them against
 * keyboard events. Handles cross-platform modifier keys and Caps Lock.
 */

import { normalizeKeyForShortcut } from "./keyboard";

/** Parsed representation of a single keyboard shortcut step */
export interface ParsedShortcut {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

/** A chord shortcut is a sequence of two key presses (e.g., "Alt+M T") */
export interface ParsedChord {
  prefix: ParsedShortcut;
  suffix: ParsedShortcut;
}

/** Special key display names */
const DISPLAY_NAMES: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  " ": "Space",
  Escape: "Esc",
  Delete: "Del",
  Backspace: "Backspace",
  Enter: "Enter",
  Tab: "Tab",
};

/** Modifier keys in ParsedShortcut (excludes "key") */
type ModifierKey = "ctrl" | "shift" | "alt" | "meta";

/** Modifier key aliases (for parsing user input) */
const MODIFIER_ALIASES: Record<string, ModifierKey> = {
  ctrl: "ctrl",
  control: "ctrl",
  cmd: "meta",
  command: "meta",
  meta: "meta",
  win: "meta",
  windows: "meta",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
};

/** Key name aliases (maps user-friendly names to event.key values) */
const KEY_ALIASES: Record<string, string> = {
  left: "ArrowLeft",
  right: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  space: " ",
  spacebar: " ",
  esc: "Escape",
  escape: "Escape",
  del: "Delete",
  enter: "Enter",
  return: "Enter",
};

/** Reverse map: event.key values to shortcut string format */
const KEY_TO_SHORTCUT: Record<string, string> = {
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  " ": "Space",
};

/**
 * Parse a shortcut string into its components.
 *
 * @example
 * parseShortcut("Ctrl+Shift+P") // { key: "p", ctrl: true, shift: true, alt: false, meta: false }
 * parseShortcut("Alt+Left") // { key: "ArrowLeft", ctrl: false, shift: false, alt: true, meta: false }
 */
export function parseShortcut(shortcut: string): ParsedShortcut | null {
  if (!shortcut || shortcut.trim() === "") {
    return null;
  }

  const parts = shortcut.split("+").map((p) => p.trim());
  if (parts.length === 0) {
    return null;
  }

  const result: ParsedShortcut = {
    key: "",
    ctrl: false,
    shift: false,
    alt: false,
    meta: false,
  };

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const lowerPart = part.toLowerCase();

    // Check if it's a modifier
    const modifierKey = MODIFIER_ALIASES[lowerPart];
    if (modifierKey) {
      result[modifierKey] = true;
      continue;
    }

    // Last part (or only non-modifier part) is the key
    const aliasedKey = KEY_ALIASES[lowerPart];
    if (aliasedKey) {
      result.key = aliasedKey;
    } else if (part.length === 1) {
      // Single character - store as lowercase for consistent matching
      result.key = part.toLowerCase();
    } else {
      // Preserve casing for special keys (F1, Delete, etc.)
      result.key = part;
    }
  }

  // Must have a key to be valid
  if (!result.key) {
    return null;
  }

  return result;
}

/**
 * Check if a keyboard event matches a parsed shortcut.
 */
export function matchesShortcut(
  event: KeyboardEvent,
  shortcut: ParsedShortcut
): boolean {
  // Check modifiers
  // Use both ctrlKey and metaKey for cross-platform support (Ctrl on Windows, Cmd on Mac)
  const eventCtrl = event.ctrlKey || event.metaKey;
  if (shortcut.ctrl !== eventCtrl) return false;
  if (shortcut.shift !== event.shiftKey) return false;
  if (shortcut.alt !== event.altKey) return false;
  // Meta is checked separately for explicit meta shortcuts
  if (shortcut.meta && !event.metaKey) return false;

  // Normalize and compare the key
  const normalizedEventKey = normalizeKeyForShortcut(event.key);
  const normalizedShortcutKey = normalizeKeyForShortcut(shortcut.key);

  return normalizedEventKey === normalizedShortcutKey;
}

/**
 * Check if a shortcut string is a chord (two-step sequence).
 * Chord shortcuts use a space to separate the two steps: "Alt+M T"
 */
export function isChordShortcut(shortcutString: string): boolean {
  return shortcutString.includes(" ");
}

/**
 * Parse a chord shortcut string into prefix and suffix.
 * @example parseChord("Alt+M T") => { prefix: Alt+M, suffix: T }
 */
export function parseChord(shortcutString: string): ParsedChord | null {
  const spaceIndex = shortcutString.indexOf(" ");
  if (spaceIndex === -1) return null;

  const prefixStr = shortcutString.substring(0, spaceIndex).trim();
  const suffixStr = shortcutString.substring(spaceIndex + 1).trim();

  const prefix = parseShortcut(prefixStr);
  const suffix = parseShortcut(suffixStr);

  if (!prefix || !suffix) return null;
  return { prefix, suffix };
}

/**
 * Check if a keyboard event matches a shortcut string.
 */
export function matchesShortcutString(
  event: KeyboardEvent,
  shortcutString: string
): boolean {
  // Chord shortcuts should not be matched as single-key shortcuts
  if (isChordShortcut(shortcutString)) return false;

  const parsed = parseShortcut(shortcutString);
  if (!parsed) return false;
  return matchesShortcut(event, parsed);
}

/**
 * Format a single parsed shortcut for display.
 */
function formatParsedShortcut(parsed: ParsedShortcut): string {
  const parts: string[] = [];

  if (parsed.ctrl) parts.push("Ctrl");
  if (parsed.shift) parts.push("Shift");
  if (parsed.alt) parts.push("Alt");
  if (parsed.meta) parts.push("Meta");

  // Format the key for display
  let displayKey = parsed.key;
  if (DISPLAY_NAMES[parsed.key]) {
    displayKey = DISPLAY_NAMES[parsed.key];
  } else if (parsed.key.length === 1) {
    displayKey = parsed.key.toUpperCase();
  }

  parts.push(displayKey);

  return parts.join("+");
}

/**
 * Format a shortcut for display (e.g., for showing in UI).
 * Supports both single shortcuts and chord shortcuts.
 */
export function formatShortcut(shortcut: string): string {
  if (isChordShortcut(shortcut)) {
    const chord = parseChord(shortcut);
    if (!chord) return shortcut;
    return `${formatParsedShortcut(chord.prefix)} ${formatParsedShortcut(chord.suffix)}`;
  }

  const parsed = parseShortcut(shortcut);
  if (!parsed) return shortcut;
  return formatParsedShortcut(parsed);
}

/** Modifier keys that should be ignored when pressed alone */
const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

/**
 * Convert a KeyboardEvent to a shortcut string.
 * Useful for recording new keybindings.
 */
export function eventToShortcutString(event: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(event.key)) {
    return null;
  }

  const parts: string[] = [];

  if (event.ctrlKey || event.metaKey) parts.push("Ctrl");
  if (event.shiftKey) parts.push("Shift");
  if (event.altKey) parts.push("Alt");

  // Format the key using lookup or uppercase for single chars
  const key = KEY_TO_SHORTCUT[event.key] ??
    (event.key.length === 1 ? event.key.toUpperCase() : event.key);

  parts.push(key);

  return parts.join("+");
}
